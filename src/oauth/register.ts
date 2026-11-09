import { Router } from "express";
import { randomUUID } from "crypto";
import { getDb } from "../db/database.js";
import { rateLimit } from "../web/rateLimit.js";

const router = Router();

const MAX_REDIRECT_URIS = 10;
const MAX_URI_LENGTH = 2000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function validateRedirectUri(uri: unknown): string | null {
  if (typeof uri !== "string" || uri.length > MAX_URI_LENGTH) return "redirect_uris must be strings (max 2000 chars)";
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return "redirect_uris must be valid URLs";
  }
  if (parsed.hash) return "redirect_uris must not contain a fragment";
  if (parsed.username || parsed.password) return "redirect_uris must not contain credentials";
  if (parsed.protocol === "https:") return null;
  // OAuth 2.1: plain http only for loopback redirects (native/CLI clients)
  if (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname)) return null;
  return "redirect_uris must use https (http is only allowed for localhost)";
}

function handleRegister(req: any, res: any) {
  const { client_name, redirect_uris, grant_types, response_types } = req.body ?? {};

  if (!Array.isArray(redirect_uris) || redirect_uris.length === 0 || redirect_uris.length > MAX_REDIRECT_URIS) {
    return res.status(400).json({ error: "invalid_redirect_uri", error_description: `1-${MAX_REDIRECT_URIS} redirect_uris required` });
  }
  for (const uri of redirect_uris) {
    const problem = validateRedirectUri(uri);
    if (problem) return res.status(400).json({ error: "invalid_redirect_uri", error_description: problem });
  }
  if (client_name !== undefined && (typeof client_name !== "string" || client_name.length > 100)) {
    return res.status(400).json({ error: "invalid_client_metadata", error_description: "client_name must be a string (max 100 chars)" });
  }

  const grants = Array.isArray(grant_types)
    ? grant_types.filter((g: unknown) => g === "authorization_code" || g === "refresh_token")
    : ["authorization_code", "refresh_token"];
  const responses = ["code"];
  if (response_types !== undefined && (!Array.isArray(response_types) || response_types.some((r: unknown) => r !== "code"))) {
    return res.status(400).json({ error: "invalid_client_metadata", error_description: "Only response_type 'code' is supported" });
  }

  const clientId = randomUUID();
  getDb().prepare(`
    INSERT INTO oauth_clients (client_id, client_name, redirect_uris, grant_types, response_types)
    VALUES (?, ?, ?, ?, ?)
  `).run(clientId, client_name || null, JSON.stringify(redirect_uris), JSON.stringify(grants), JSON.stringify(responses));

  res.status(201).json({
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: client_name || null,
    redirect_uris,
    grant_types: grants,
    response_types: responses,
    token_endpoint_auth_method: "none",
  });
}

// Registration is unauthenticated by design (RFC 7591 / MCP) → limit it per IP
const limiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 30, message: "Too many client registrations" });

// Mount at both paths (Claude.ai may ignore the metadata registration_endpoint)
router.post("/oauth/register", limiter, handleRegister);
router.post("/register", limiter, handleRegister);

export default router;
