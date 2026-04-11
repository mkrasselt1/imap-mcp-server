import { Router } from "express";
import { verifyUser, getUserById, createUser } from "../auth/users.js";
import { getAccountsByUser, createAccount, deleteAccount } from "../imap/accounts.js";
import { getDb } from "../db/database.js";
import { layout } from "./views/layout.js";
import { escapeHtml } from "./views/escapeHtml.js";
import type { OAuthToken } from "../types.js";

const router = Router();

// -- Login --
router.get("/login", (req, res) => {
  const error = req.query.error as string | undefined;
  res.send(layout("Login", `
    <div class="card">
      <h2>Login</h2>
      ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
      <form method="POST" action="/login">
        <label>Username</label>
        <input type="text" name="username" required autofocus>
        <label>Password</label>
        <input type="password" name="password" required>
        <button type="submit">Login</button>
      </form>
      <p style="margin-top:12px" class="small">
        No account? <a href="/signup">Create one</a>
      </p>
    </div>
  `));
});

router.post("/login", (req, res) => {
  const { username, password } = req.body;
  const user = verifyUser(username, password);
  if (!user) {
    return res.redirect("/login?error=Invalid+credentials");
  }
  req.session.userId = user.id;
  const returnTo = req.session.returnTo;
  delete req.session.returnTo;
  res.redirect(returnTo || "/dashboard");
});

// -- Signup --
router.get("/signup", (req, res) => {
  res.send(layout("Create Account", `
    <div class="card">
      <h2>Create Account</h2>
      <form method="POST" action="/signup">
        <label>Username</label>
        <input type="text" name="username" required autofocus>
        <label>Password</label>
        <input type="password" name="password" required>
        <button type="submit">Create Account</button>
      </form>
    </div>
  `));
});

router.post("/signup", (req, res) => {
  const { username, password } = req.body;
  try {
    const user = createUser(username, password);
    req.session.userId = user.id;
    res.redirect("/dashboard");
  } catch (e: any) {
    if (e.message?.includes("UNIQUE")) {
      return res.redirect("/login?error=Username+already+taken");
    }
    throw e;
  }
});

// -- Logout --
router.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

// -- Dashboard --
router.get("/dashboard", requireLogin, (req, res) => {
  const user = getUserById(req.session.userId!)!;
  const accounts = getAccountsByUser(user.id);

  const db = getDb();
  const tokens = db.prepare(
    "SELECT * FROM oauth_tokens WHERE user_id = ? AND revoked = 0"
  ).all(user.id) as OAuthToken[];

  const accountRows = accounts.map(a => `
    <tr>
      <td><strong>${escapeHtml(a.label)}</strong></td>
      <td>${escapeHtml(a.username)}</td>
      <td>${escapeHtml(a.imap_host)}:${a.imap_port}</td>
      <td>
        <form method="POST" action="/accounts/${a.id}/delete" style="display:inline;">
          <button class="btn-danger" style="margin:0;padding:4px 12px;font-size:12px;">Delete</button>
        </form>
      </td>
    </tr>
  `).join("");

  const tokenRows = tokens.map(t => `
    <tr>
      <td>${t.client_id.slice(0, 8)}...</td>
      <td>${t.scopes}</td>
      <td class="small">${t.access_token_expires_at}</td>
      <td>
        <form method="POST" action="/tokens/${t.id}/revoke" style="display:inline;">
          <button class="btn-danger" style="margin:0;padding:4px 12px;font-size:12px;">Revoke</button>
        </form>
      </td>
    </tr>
  `).join("");

  res.send(layout("Dashboard", `
    <div class="card">
      <h2>Email Accounts</h2>
      ${accounts.length > 0 ? `
        <table>
          <tr><th>Label</th><th>Username</th><th>Server</th><th></th></tr>
          ${accountRows}
        </table>
      ` : `<p>No email accounts configured yet.</p>`}
      <a href="/accounts/add" class="btn">Add Email Account</a>
    </div>

    <div class="card">
      <h2>Active Agent Tokens</h2>
      ${tokens.length > 0 ? `
        <table>
          <tr><th>Client</th><th>Scopes</th><th>Expires</th><th></th></tr>
          ${tokenRows}
        </table>
      ` : `<p>No active agent connections.</p>`}
    </div>
  `, user.username));
});

// -- Add Account --
router.get("/accounts/add", requireLogin, (req, res) => {
  const user = getUserById(req.session.userId!)!;
  res.send(layout("Add Email Account", `
    <div class="card">
      <h2>Add Email Account</h2>
      <form method="POST" action="/accounts/add">
        <label>Label (e.g. "Work Gmail")</label>
        <input type="text" name="label" required>

        <h3 style="margin-top:20px;">IMAP Settings (Incoming)</h3>
        <label>IMAP Host</label>
        <input type="text" name="imap_host" placeholder="imap.gmail.com" required>
        <label>IMAP Port</label>
        <input type="number" name="imap_port" value="993" required>
        <label>Use TLS</label>
        <select name="imap_tls"><option value="1" selected>Yes</option><option value="0">No</option></select>

        <h3 style="margin-top:20px;">Login Credentials</h3>
        <label>Username / Email</label>
        <input type="text" name="username" required>
        <label>Password / App Password</label>
        <input type="password" name="password" required>

        <h3 style="margin-top:20px;">SMTP Settings (Outgoing, optional)</h3>
        <label>SMTP Host</label>
        <input type="text" name="smtp_host" placeholder="smtp.gmail.com">
        <label>SMTP Port</label>
        <input type="number" name="smtp_port" value="587">
        <label>Use TLS</label>
        <select name="smtp_tls"><option value="1" selected>Yes</option><option value="0">No</option></select>

        <button type="submit">Save Account</button>
      </form>
    </div>
  `, user.username));
});

router.post("/accounts/add", requireLogin, (req, res) => {
  const imapPort = parseInt(req.body.imap_port, 10);
  const smtpPort = req.body.smtp_port ? parseInt(req.body.smtp_port, 10) : undefined;

  if (isNaN(imapPort) || imapPort < 1 || imapPort > 65535) {
    return res.status(400).send("Invalid IMAP port (must be 1-65535)");
  }
  if (smtpPort !== undefined && (isNaN(smtpPort) || smtpPort < 1 || smtpPort > 65535)) {
    return res.status(400).send("Invalid SMTP port (must be 1-65535)");
  }

  createAccount({
    userId: req.session.userId!,
    label: req.body.label,
    imapHost: req.body.imap_host,
    imapPort,
    imapTls: req.body.imap_tls === "1",
    username: req.body.username,
    password: req.body.password,
    smtpHost: req.body.smtp_host || undefined,
    smtpPort,
    smtpTls: req.body.smtp_tls === "1",
  });
  res.redirect("/dashboard");
});

router.post("/accounts/:id/delete", requireLogin, (req, res) => {
  deleteAccount(req.params.id, req.session.userId!);
  res.redirect("/dashboard");
});

// -- Revoke Token --
router.post("/tokens/:id/revoke", requireLogin, (req, res) => {
  const db = getDb();
  db.prepare("UPDATE oauth_tokens SET revoked = 1 WHERE id = ? AND user_id = ?")
    .run(req.params.id, req.session.userId!);
  res.redirect("/dashboard");
});

// -- Home redirect --
router.get("/", (req, res) => {
  res.redirect(req.session.userId ? "/dashboard" : "/login");
});

function requireLogin(req: any, res: any, next: any) {
  if (!req.session.userId) {
    req.session.returnTo = req.originalUrl;
    return res.redirect("/login");
  }
  next();
}

export default router;
