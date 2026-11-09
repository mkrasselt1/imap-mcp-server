import type { Request, Response, NextFunction } from "express";
import { getDb } from "../db/database.js";
import { config } from "../config.js";
import { hashToken } from "./tokenHash.js";
import type { OAuthToken } from "../types.js";

function challenge(error?: string, description?: string): string {
  // RFC 9728: point MCP clients to the authorization server metadata
  let h = `Bearer resource_metadata="${config.baseUrl}/.well-known/oauth-protected-resource"`;
  if (error) h += `, error="${error}"`;
  if (description) h += `, error_description="${description}"`;
  return h;
}

export function bearerAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.setHeader("WWW-Authenticate", challenge());
    return res.status(401).json({ error: "unauthorized", error_description: "Bearer token required" });
  }

  const accessToken = authHeader.slice(7).trim();
  const token = getDb().prepare(
    "SELECT * FROM oauth_tokens WHERE access_token = ? AND revoked = 0"
  ).get(hashToken(accessToken)) as OAuthToken | undefined;

  if (!token) {
    res.setHeader("WWW-Authenticate", challenge("invalid_token"));
    return res.status(401).json({ error: "invalid_token" });
  }
  if (new Date(token.access_token_expires_at) < new Date()) {
    res.setHeader("WWW-Authenticate", challenge("invalid_token", "Token expired"));
    return res.status(401).json({ error: "invalid_token", error_description: "Token expired" });
  }

  req.tokenContext = {
    userId: token.user_id,
    accountId: token.account_id,
    scopes: token.scopes.split(" "),
    clientId: token.client_id,
  };

  next();
}
