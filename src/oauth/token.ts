import { Router } from "express";
import { randomUUID } from "crypto";
import { getDb } from "../db/database.js";
import { verifyPKCE } from "./pkce.js";
import { hashToken, newToken } from "./tokenHash.js";
import type { OAuthCode, OAuthToken } from "../types.js";

const router = Router();

const ACCESS_TTL_S = 60 * 60; // 1 hour
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

router.post("/oauth/token", (req, res) => {
  // RFC 6749 §5.1: token responses must not be cached
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");

  const { grant_type } = req.body ?? {};
  if (grant_type === "authorization_code") return handleAuthorizationCode(req, res);
  if (grant_type === "refresh_token") return handleRefreshToken(req, res);
  res.status(400).json({ error: "unsupported_grant_type" });
});

function issueTokens(t: { client_id: string; user_id: string; account_id: string; scopes: string }) {
  const accessToken = newToken();
  const refreshToken = newToken();
  getDb().prepare(`
    INSERT INTO oauth_tokens (id, access_token, refresh_token, client_id, user_id, account_id, scopes, access_token_expires_at, refresh_token_expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(), hashToken(accessToken), hashToken(refreshToken), t.client_id, t.user_id, t.account_id, t.scopes,
    new Date(Date.now() + ACCESS_TTL_S * 1000).toISOString(),
    new Date(Date.now() + REFRESH_TTL_MS).toISOString(),
  );
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_S,
    refresh_token: refreshToken,
    scope: t.scopes,
  };
}

function handleAuthorizationCode(req: any, res: any) {
  const { code, client_id, redirect_uri, code_verifier } = req.body;

  if (typeof code !== "string" || typeof client_id !== "string" || typeof code_verifier !== "string") {
    return res.status(400).json({ error: "invalid_request", error_description: "Missing required parameters" });
  }

  const db = getDb();
  const codeHash = hashToken(code);
  const authCode = db.prepare("SELECT * FROM oauth_codes WHERE code = ?").get(codeHash) as OAuthCode | undefined;

  if (!authCode || authCode.used) {
    return res.status(400).json({ error: "invalid_grant", error_description: "Invalid or already used authorization code" });
  }
  if (new Date(authCode.expires_at) < new Date()) {
    return res.status(400).json({ error: "invalid_grant", error_description: "Code expired" });
  }
  if (authCode.client_id !== client_id) {
    return res.status(400).json({ error: "invalid_grant", error_description: "Client mismatch" });
  }
  if (authCode.redirect_uri !== redirect_uri) {
    return res.status(400).json({ error: "invalid_grant", error_description: "Redirect URI mismatch" });
  }
  if (!verifyPKCE(code_verifier, authCode.code_challenge)) {
    return res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
  }

  // Atomically consume the code: two parallel requests cannot both redeem it
  const consumed = db.prepare("UPDATE oauth_codes SET used = 1 WHERE code = ? AND used = 0").run(codeHash);
  if (consumed.changes !== 1) {
    return res.status(400).json({ error: "invalid_grant", error_description: "Code already used" });
  }

  res.json(issueTokens(authCode));
}

function handleRefreshToken(req: any, res: any) {
  const { refresh_token, client_id } = req.body;

  if (typeof refresh_token !== "string" || !refresh_token) {
    return res.status(400).json({ error: "invalid_request" });
  }

  const db = getDb();
  const token = db.prepare("SELECT * FROM oauth_tokens WHERE refresh_token = ? AND revoked = 0")
    .get(hashToken(refresh_token)) as OAuthToken | undefined;

  if (!token) {
    return res.status(400).json({ error: "invalid_grant", error_description: "Invalid refresh token" });
  }
  if (token.refresh_token_expires_at && new Date(token.refresh_token_expires_at) < new Date()) {
    return res.status(400).json({ error: "invalid_grant", error_description: "Refresh token expired" });
  }
  if (client_id && token.client_id !== client_id) {
    return res.status(400).json({ error: "invalid_grant", error_description: "Client mismatch" });
  }
  // The account may have been deleted in the meantime
  if (!db.prepare("SELECT 1 FROM imap_accounts WHERE id = ? AND user_id = ?").get(token.account_id, token.user_id)) {
    db.prepare("UPDATE oauth_tokens SET revoked = 1 WHERE id = ?").run(token.id);
    return res.status(400).json({ error: "invalid_grant", error_description: "Account no longer exists" });
  }

  // Rotation: atomically revoke the old token, so a refresh token works exactly once
  const rotated = db.prepare("UPDATE oauth_tokens SET revoked = 1 WHERE id = ? AND revoked = 0").run(token.id);
  if (rotated.changes !== 1) {
    return res.status(400).json({ error: "invalid_grant", error_description: "Refresh token already used" });
  }

  res.json(issueTokens(token));
}

export default router;
