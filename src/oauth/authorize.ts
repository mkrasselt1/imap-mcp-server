import { Router } from "express";
import type { Response } from "express";
import { getDb } from "../db/database.js";
import { getAccountsByUser } from "../imap/accounts.js";
import { SCOPES } from "../types.js";
import type { OAuthClient } from "../types.js";
import { escapeHtml } from "../web/views/escapeHtml.js";
import { csrfField, verifyCsrf } from "../web/csrf.js";
import { CODE_CHALLENGE_RE } from "./pkce.js";
import { hashToken, newToken } from "./tokenHash.js";

const router = Router();

type Params = { client_id: string; redirect_uri: string; state?: string; code_challenge: string; code_challenge_method: string };

/** Validate the request against the registered client. Returns an error message or the client. */
function validate(p: Partial<Params>): { error: string } | { client: OAuthClient } {
  if (!p.client_id || !p.redirect_uri || !p.code_challenge) {
    return { error: "Missing required parameters: client_id, redirect_uri, code_challenge" };
  }
  if (p.code_challenge_method && p.code_challenge_method !== "S256") {
    return { error: "Only S256 code_challenge_method is supported" };
  }
  if (!CODE_CHALLENGE_RE.test(p.code_challenge)) {
    return { error: "Invalid code_challenge" };
  }
  if (p.state !== undefined && (typeof p.state !== "string" || p.state.length > 1000)) {
    return { error: "Invalid state" };
  }
  const client = getDb().prepare("SELECT * FROM oauth_clients WHERE client_id = ?").get(p.client_id) as OAuthClient | undefined;
  if (!client) return { error: "Unknown client_id" };
  const allowedUris: string[] = JSON.parse(client.redirect_uris);
  if (!allowedUris.includes(p.redirect_uri)) return { error: "redirect_uri not registered for this client" };
  return { client };
}

/** CSP form-action also governs the redirect after the consent form is submitted (Chrome). */
function allowRedirectTarget(res: Response, redirectUri: string) {
  const origin = new URL(redirectUri).origin;
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${origin}; frame-ancestors 'none'`,
  );
}

router.get("/oauth/authorize", (req, res) => {
  const q = req.query as Record<string, string>;
  if (q.response_type !== "code") {
    return res.status(400).send("Unsupported response_type. Must be 'code'.");
  }
  const v = validate(q);
  if ("error" in v) return res.status(400).send(escapeHtml(v.error));

  // If not logged in, redirect to login with return URL
  if (!req.session.userId) {
    req.session.returnTo = req.originalUrl;
    return res.redirect("/login");
  }

  const accounts = getAccountsByUser(req.session.userId);
  const requestedScopes = q.scope ? q.scope.split(" ") : Object.keys(SCOPES);

  allowRedirectTarget(res, q.redirect_uri);
  res.setHeader("Cache-Control", "no-store");
  res.send(renderConsentPage({
    clientName: v.client.client_name || v.client.client_id,
    redirectHost: new URL(q.redirect_uri).host,
    requestedScopes,
    accounts,
    csrf: csrfField(req),
    query: {
      client_id: q.client_id,
      redirect_uri: q.redirect_uri,
      state: q.state ?? "",
      code_challenge: q.code_challenge,
      code_challenge_method: "S256",
    },
  }));
});

router.post("/oauth/authorize", verifyCsrf, (req, res) => {
  if (!req.session.userId) {
    return res.status(401).send("Not authenticated");
  }

  const p = req.body as Params & { account_id?: string; action?: string };
  const v = validate(p);
  if ("error" in v) return res.status(400).send(escapeHtml(v.error));

  const redirectUrl = new URL(p.redirect_uri);
  if (p.state) redirectUrl.searchParams.set("state", p.state);

  if (p.action === "deny") {
    redirectUrl.searchParams.set("error", "access_denied");
    return res.redirect(redirectUrl.toString());
  }

  const grantedScopes = Object.keys(SCOPES).filter((s) => req.body[`scope_${s}`]);
  if (grantedScopes.length === 0) {
    return res.status(400).send("At least one permission must be granted");
  }
  if (!p.account_id) {
    return res.status(400).send("An email account must be selected");
  }

  // Verify the account belongs to the authenticated user
  const accounts = getAccountsByUser(req.session.userId);
  if (!accounts.some((a) => a.id === p.account_id)) {
    return res.status(403).send("Account does not belong to you");
  }

  const code = newToken();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  getDb().prepare(`
    INSERT INTO oauth_codes (code, client_id, user_id, account_id, redirect_uri, scopes, code_challenge, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(hashToken(code), p.client_id, req.session.userId, p.account_id, p.redirect_uri, grantedScopes.join(" "), p.code_challenge, expiresAt);

  redirectUrl.searchParams.set("code", code);
  res.redirect(redirectUrl.toString());
});

function renderConsentPage(opts: {
  clientName: string;
  redirectHost: string;
  requestedScopes: string[];
  accounts: { id: string; label: string; username: string }[];
  csrf: string;
  query: Record<string, string>;
}): string {
  const scopeCheckboxes = opts.requestedScopes
    .filter((s): s is keyof typeof SCOPES => s in SCOPES)
    .map(
      (s) =>
        `<label style="display:block;margin:8px 0;"><input type="checkbox" name="scope_${s}" value="1" checked> <strong>${s}</strong> — ${SCOPES[s]}</label>`
    )
    .join("\n");

  const accountOptions = opts.accounts
    .map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.label)} (${escapeHtml(a.username)})</option>`)
    .join("\n");

  const hiddenFields = Object.entries(opts.query)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("\n");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize Access</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 500px; margin: 60px auto; padding: 20px; }
  .card { border: 1px solid #ddd; border-radius: 8px; padding: 24px; }
  h2 { margin-top: 0; }
  button { background: #2563eb; color: white; border: none; padding: 10px 24px; border-radius: 6px; cursor: pointer; font-size: 16px; margin-top: 16px; }
  button:hover { background: #1d4ed8; }
  select { width: 100%; padding: 8px; margin-top: 4px; border-radius: 4px; border: 1px solid #ccc; }
  .deny { background: #6b7280; margin-left: 8px; }
  .deny:hover { background: #4b5563; }
  .host { font-family: monospace; background: #f3f4f6; padding: 2px 6px; border-radius: 4px; }
</style>
</head><body>
<div class="card">
  <h2>Authorize Access</h2>
  <p><strong>${escapeHtml(opts.clientName)}</strong> wants to access your email.</p>
  <p style="font-size:13px;color:#555;">After approval you will be sent to <span class="host">${escapeHtml(opts.redirectHost)}</span>.
  Only continue if you started this connection yourself.</p>

  <form method="POST" action="/oauth/authorize">
    ${opts.csrf}
    ${hiddenFields}

    <h3>Select Email Account</h3>
    ${opts.accounts.length > 0
      ? `<select name="account_id">${accountOptions}</select>`
      : `<p style="color:red;">No email accounts configured. <a href="/accounts/add">Add one first</a>.</p>`
    }

    <h3>Permissions</h3>
    ${scopeCheckboxes}

    <div style="margin-top:20px;">
      <button type="submit" name="action" value="allow">Authorize</button>
      <button type="submit" name="action" value="deny" class="deny" formnovalidate>Deny</button>
    </div>
  </form>
</div>
</body></html>`;
}

export default router;
