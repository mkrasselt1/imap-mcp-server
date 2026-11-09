import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { verifyUser, getUserById, createUser, changePassword } from "../auth/users.js";
import { destroyUserSessions } from "../auth/sessionStore.js";
import { getAccountsByUser, createAccount, deleteAccount } from "../imap/accounts.js";
import { closeConnection } from "../imap/client.js";
import { getDb } from "../db/database.js";
import { config } from "../config.js";
import { layout } from "./views/layout.js";
import { escapeHtml } from "./views/escapeHtml.js";
import { csrfField, verifyCsrf } from "./csrf.js";
import { rateLimit } from "./rateLimit.js";

const router = Router();

// No caching of any page that may contain personal data or CSRF tokens
router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

// Brute-force protection: per IP, and per IP+username
const loginLimiterIp = rateLimit({ windowMs: 15 * 60 * 1000, max: 50, message: "Too many login attempts. Try again later." });
const loginLimiterUser = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  key: (req) => `${req.ip}|${String(req.body?.username || "").toLowerCase()}`,
  message: "Too many login attempts for this user. Try again in 15 minutes.",
});
const signupLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: "Too many sign-ups from this address." });

/** Prevent session fixation: new session ID on every privilege change. */
function loginAs(req: Request, userId: string, done: (err?: any) => void) {
  const returnTo = req.session.returnTo;
  req.session.regenerate((err) => {
    if (err) return done(err);
    req.session.userId = userId;
    req.session.returnTo = returnTo;
    req.session.save(done);
  });
}

function safeReturnTo(returnTo: string | undefined): string {
  // Only same-site relative paths (no //host, no /\host)
  return returnTo && /^\/(?![\/\\])/.test(returnTo) ? returnTo : "/dashboard";
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

const HOST_RE = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$|^\[?[0-9a-fA-F:.]+\]?$/;

// -- Login --
router.get("/login", (req, res) => {
  const error = req.query.error as string | undefined;
  res.send(layout("Login", `
    <div class="card">
      <h2>Login</h2>
      ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
      <form method="POST" action="/login">
        ${csrfField(req)}
        <label>Username</label>
        <input type="text" name="username" required autofocus autocomplete="username">
        <label>Password</label>
        <input type="password" name="password" required autocomplete="current-password">
        <button type="submit">Login</button>
      </form>
      ${config.allowSignup ? `<p style="margin-top:12px" class="small">No account? <a href="/signup">Create one</a></p>` : ""}
    </div>
  `));
});

router.post("/login", loginLimiterIp, loginLimiterUser, verifyCsrf, (req, res, next) => {
  const user = verifyUser(req.body.username, req.body.password);
  if (!user) {
    return res.redirect("/login?error=Invalid+credentials");
  }
  loginAs(req, user.id, (err) => {
    if (err) return next(err);
    const returnTo = req.session.returnTo;
    delete req.session.returnTo;
    res.redirect(safeReturnTo(returnTo));
  });
});

// -- Signup (only if ALLOW_SIGNUP is set) --
function signupEnabled(_req: Request, res: Response, next: NextFunction) {
  if (!config.allowSignup) return res.status(404).send("Sign-up is disabled on this server.");
  next();
}

router.get("/signup", signupEnabled, (req, res) => {
  const error = req.query.error as string | undefined;
  res.send(layout("Create Account", `
    <div class="card">
      <h2>Create Account</h2>
      ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
      <form method="POST" action="/signup">
        ${csrfField(req)}
        <label>Username</label>
        <input type="text" name="username" required autofocus autocomplete="username" minlength="3" maxlength="64">
        <label>Password</label>
        <input type="password" name="password" required autocomplete="new-password" minlength="8" maxlength="128">
        <button type="submit">Create Account</button>
      </form>
    </div>
  `));
});

router.post("/signup", signupEnabled, signupLimiter, verifyCsrf, (req, res, next) => {
  const { username, password } = req.body;

  if (typeof username !== "string" || username.length < 3 || username.length > 64) {
    return res.redirect("/signup?error=Username+must+be+3-64+characters");
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(username)) {
    return res.redirect("/signup?error=Username+contains+invalid+characters");
  }
  if (typeof password !== "string" || password.length < 8 || password.length > 128) {
    return res.redirect("/signup?error=Password+must+be+8-128+characters");
  }

  let user;
  try {
    user = createUser(username, password);
  } catch (e: any) {
    if (e.message?.includes("UNIQUE")) {
      return res.redirect("/signup?error=Username+already+taken");
    }
    return next(e);
  }
  loginAs(req, user.id, (err) => (err ? next(err) : res.redirect("/dashboard")));
});

// -- Logout (POST: a link/image on another site cannot log you out) --
router.post("/logout", verifyCsrf, (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});
router.get("/logout", (req, res) => {
  if (!req.session.userId) return res.redirect("/login");
  res.send(layout("Logout", `
    <div class="card"><h2>Logout</h2>
      <form method="POST" action="/logout">${csrfField(req)}<button type="submit">Log out</button></form>
    </div>`, undefined));
});

// -- Dashboard --
router.get("/dashboard", requireLogin, (req, res) => {
  const user = getUserById(req.session.userId!)!;
  const accounts = getAccountsByUser(user.id);
  const csrf = csrfField(req);

  const tokens = getDb().prepare(`
    SELECT t.id, t.scopes, t.access_token_expires_at, t.refresh_token_expires_at, t.client_id,
           c.client_name, a.label AS account_label
    FROM oauth_tokens t
    LEFT JOIN oauth_clients c ON c.client_id = t.client_id
    LEFT JOIN imap_accounts a ON a.id = t.account_id
    WHERE t.user_id = ? AND t.revoked = 0
      AND COALESCE(t.refresh_token_expires_at, t.access_token_expires_at) > ?
    ORDER BY t.access_token_expires_at DESC
  `).all(user.id, new Date().toISOString()) as any[];

  const accountRows = accounts.map(a => `
    <tr>
      <td><strong>${escapeHtml(a.label)}</strong></td>
      <td>${escapeHtml(a.username)}</td>
      <td>${escapeHtml(a.imap_host)}:${a.imap_port}</td>
      <td>
        <form method="POST" action="/accounts/${encodeURIComponent(a.id)}/delete" style="display:inline;">
          ${csrf}
          <button class="btn-danger" style="margin:0;padding:4px 12px;font-size:12px;">Delete</button>
        </form>
      </td>
    </tr>
  `).join("");

  const tokenRows = tokens.map(t => `
    <tr>
      <td>${escapeHtml(t.client_name || t.client_id.slice(0, 8) + "…")}</td>
      <td>${escapeHtml(t.account_label || "?")}</td>
      <td class="small">${escapeHtml(t.scopes)}</td>
      <td class="small">${escapeHtml(t.refresh_token_expires_at || t.access_token_expires_at)}</td>
      <td>
        <form method="POST" action="/tokens/${encodeURIComponent(t.id)}/revoke" style="display:inline;">
          ${csrf}
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
      <h2>Connected Agents</h2>
      ${tokens.length > 0 ? `
        <table>
          <tr><th>Client</th><th>Account</th><th>Scopes</th><th>Valid until</th><th></th></tr>
          ${tokenRows}
        </table>
      ` : `<p>No active agent connections.</p>`}
    </div>

    <div class="card">
      <a href="/change-password" class="btn">Change Password</a>
    </div>
  `, user.username, csrf));
});

// -- Add Account --
router.get("/accounts/add", requireLogin, (req, res) => {
  const user = getUserById(req.session.userId!)!;
  const error = req.query.error as string | undefined;
  res.send(layout("Add Email Account", `
    <div class="card">
      <h2>Add Email Account</h2>
      ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
      <form method="POST" action="/accounts/add">
        ${csrfField(req)}
        <label>Label (e.g. "Work Gmail")</label>
        <input type="text" name="label" required maxlength="100">

        <h3 style="margin-top:20px;">IMAP Settings (Incoming)</h3>
        <label>IMAP Host</label>
        <input type="text" name="imap_host" placeholder="imap.gmail.com" required maxlength="253">
        <label>IMAP Port</label>
        <input type="number" name="imap_port" value="993" required min="1" max="65535">
        <label>Use TLS</label>
        <select name="imap_tls"><option value="1" selected>Yes</option><option value="0">No (insecure)</option></select>

        <h3 style="margin-top:20px;">Login Credentials</h3>
        <label>Username / Email</label>
        <input type="text" name="username" required maxlength="320" autocomplete="off">
        <label>Password / App Password</label>
        <input type="password" name="password" required maxlength="1024" autocomplete="new-password">

        <h3 style="margin-top:20px;">SMTP Settings (Outgoing, optional)</h3>
        <label>SMTP Host</label>
        <input type="text" name="smtp_host" placeholder="smtp.gmail.com" maxlength="253">
        <label>SMTP Port</label>
        <input type="number" name="smtp_port" value="587" min="1" max="65535">
        <label>Use TLS</label>
        <select name="smtp_tls"><option value="1" selected>Yes</option><option value="0">No (insecure)</option></select>

        <button type="submit">Save Account</button>
      </form>
    </div>
  `, user.username, csrfField(req)));
});

router.post("/accounts/add", requireLogin, verifyCsrf, (req, res) => {
  const fail = (msg: string) => res.redirect(`/accounts/add?error=${encodeURIComponent(msg)}`);

  const label = str(req.body.label, 100);
  const imapHost = str(req.body.imap_host, 253);
  const smtpHost = str(req.body.smtp_host, 253);
  const username = str(req.body.username, 320);
  const password = typeof req.body.password === "string" ? req.body.password.slice(0, 1024) : "";
  const imapPort = parseInt(req.body.imap_port, 10);
  const smtpPort = req.body.smtp_port ? parseInt(req.body.smtp_port, 10) : undefined;

  if (!label || !username || !password) return fail("Label, username and password are required");
  if (!HOST_RE.test(imapHost)) return fail("Invalid IMAP host");
  if (smtpHost && !HOST_RE.test(smtpHost)) return fail("Invalid SMTP host");
  if (isNaN(imapPort) || imapPort < 1 || imapPort > 65535) return fail("Invalid IMAP port (must be 1-65535)");
  if (smtpPort !== undefined && (isNaN(smtpPort) || smtpPort < 1 || smtpPort > 65535)) {
    return fail("Invalid SMTP port (must be 1-65535)");
  }
  if (getAccountsByUser(req.session.userId!).length >= 20) return fail("Maximum of 20 accounts reached");

  createAccount({
    userId: req.session.userId!,
    label,
    imapHost,
    imapPort,
    imapTls: req.body.imap_tls === "1",
    username,
    password,
    smtpHost: smtpHost || undefined,
    smtpPort,
    smtpTls: req.body.smtp_tls === "1",
  });
  res.redirect("/dashboard");
});

router.post("/accounts/:id/delete", requireLogin, verifyCsrf, (req, res, next) => {
  try {
    if (deleteAccount(String(req.params.id), req.session.userId!)) {
      void closeConnection(String(req.params.id)).catch(() => {});
    }
    res.redirect("/dashboard");
  } catch (e) {
    next(e);
  }
});

// -- Revoke Token --
router.post("/tokens/:id/revoke", requireLogin, verifyCsrf, (req, res) => {
  getDb().prepare("UPDATE oauth_tokens SET revoked = 1 WHERE id = ? AND user_id = ?")
    .run(req.params.id, req.session.userId!);
  res.redirect("/dashboard");
});

// -- Change Password --
router.get("/change-password", requireLogin, (req, res) => {
  const error = req.query.error as string | undefined;
  const success = req.query.success as string | undefined;
  const user = getUserById(req.session.userId!)!;
  res.send(layout("Change Password", `
    <div class="card">
      <h2>Change Password</h2>
      ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
      ${success ? `<div class="success">${escapeHtml(success)}</div>` : ""}
      <form method="POST" action="/change-password">
        ${csrfField(req)}
        <label>Current Password</label>
        <input type="password" name="current_password" required autocomplete="current-password">
        <label>New Password</label>
        <input type="password" name="new_password" required minlength="8" maxlength="128" autocomplete="new-password">
        <label>Confirm New Password</label>
        <input type="password" name="confirm_password" required minlength="8" maxlength="128" autocomplete="new-password">
        <button type="submit">Change Password</button>
      </form>
    </div>
  `, user.username, csrfField(req)));
});

router.post("/change-password", requireLogin, loginLimiterIp, verifyCsrf, (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;
  const user = getUserById(req.session.userId!)!;

  if (!verifyUser(user.username, current_password)) {
    return res.redirect("/change-password?error=Current+password+is+incorrect");
  }
  if (typeof new_password !== "string" || new_password.length < 8 || new_password.length > 128) {
    return res.redirect("/change-password?error=New+password+must+be+8-128+characters");
  }
  if (new_password !== confirm_password) {
    return res.redirect("/change-password?error=Passwords+do+not+match");
  }

  changePassword(user.id, new_password);
  destroyUserSessions(user.id, req.sessionID); // log out other browsers
  res.redirect("/change-password?success=Password+changed+successfully");
});

// -- Home redirect --
router.get("/", (req, res) => {
  res.redirect(req.session.userId ? "/dashboard" : "/login");
});

function requireLogin(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId || !getUserById(req.session.userId)) {
    if (req.method === "GET") req.session.returnTo = req.originalUrl;
    return res.redirect("/login");
  }
  next();
}

export default router;
