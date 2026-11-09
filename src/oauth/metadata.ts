import { Router } from "express";
import { config } from "../config.js";
import { SCOPES } from "../types.js";

const router = Router();

// RFC 8414 – Authorization Server Metadata
router.get("/.well-known/oauth-authorization-server", (_req, res) => {
  res.json({
    issuer: config.baseUrl,
    authorization_endpoint: `${config.baseUrl}/oauth/authorize`,
    token_endpoint: `${config.baseUrl}/oauth/token`,
    registration_endpoint: `${config.baseUrl}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: Object.keys(SCOPES),
    token_endpoint_auth_methods_supported: ["none"],
  });
});

// RFC 9728 – Protected Resource Metadata (used by current MCP clients for discovery)
router.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (_req, res) => {
  res.json({
    resource: `${config.baseUrl}/mcp`,
    authorization_servers: [config.baseUrl],
    scopes_supported: Object.keys(SCOPES),
    bearer_methods_supported: ["header"],
  });
});

export default router;
