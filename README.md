# IMAP MCP Server

[![Docker Hub](https://img.shields.io/docker/v/mkrasselt1/imap-mcp-server?label=Docker%20Hub)](https://hub.docker.com/r/mkrasselt1/imap-mcp-server)

A multi-agent, multi-user HTTP IMAP bridge that acts as a remote [MCP](https://modelcontextprotocol.io/) server with built-in OAuth 2.1 authorization. Designed to let AI agents (like Claude.ai) securely access email on behalf of users, with granular per-agent permission control.

## Features

- **MCP over Streamable HTTP** — standard protocol that Claude.ai and other MCP clients speak natively
- **OAuth 2.1 Authorization Server** — RFC 8414 discovery, RFC 7591 Dynamic Client Registration, PKCE-enforced flows
- **Multi-user / multi-agent** — each user manages their own IMAP accounts; each agent connection gets its own scoped token
- **Granular permissions** — users choose exactly which capabilities to grant each agent:
  | Scope | Grants |
  |-------|--------|
  | `mail:folders` | List mailbox folders |
  | `mail:read` | Read email messages |
  | `mail:search` | Search emails |
  | `mail:modify` | Move, flag, delete messages |
  | `mail:send` | Send emails via SMTP |
- **Encrypted credential storage** — IMAP/SMTP passwords encrypted with AES-256-GCM at rest
- **Connection pooling** — IMAP connections are reused across tool calls with auto-disconnect on idle
- **Web dashboard** — manage email accounts and revoke agent tokens

## Quick Start with Docker

> **Important:** The `-v` volume mount is required to persist your database (users, accounts, tokens) across container updates. Without it, all data is lost when the container is recreated.

```bash
docker run -d \
  --name imap-bridge \
  -p 3000:3000 \
  -v imap-bridge-data:/app/data \
  -e BASE_URL=https://your-domain.com \
  -e ENCRYPTION_KEY=$(openssl rand -hex 32) \
  -e SESSION_SECRET=$(openssl rand -hex 32) \
  mkrasselt1/imap-mcp-server
```

> **Tip:** Save your `ENCRYPTION_KEY` — if it changes, stored IMAP passwords become unrecoverable. Write it to an `.env` file or use Docker secrets.

Or with Docker Compose:

```bash
git clone https://github.com/mkrasselt1/imap-mcp-server.git
cd imap-mcp-server
cp .env.example .env
# Edit .env with your values
docker compose up -d
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BASE_URL` | Yes | Public URL of the server (e.g. `https://mail.example.com`). Must be HTTPS for Claude.ai. |
| `PORT` | No | Listen port (default: `3000`) |
| `ENCRYPTION_KEY` | Yes | 64-char hex string for AES-256-GCM encryption. Generate with `openssl rand -hex 32` |
| `SESSION_SECRET` | Yes | Random string for session cookies. Generate with `openssl rand -hex 32` |
| `ALLOW_SIGNUP` | No | `true` lets anyone who can reach the server create an account. Default: off |
| `TRUST_PROXY` | No | Number of reverse proxies in front (default: `1` if `BASE_URL` is https, else `0`) |
| `CORS_ORIGIN` | No | Comma-separated allowed origins for the API endpoints (default: any origin, never with cookies) |

The container runs with `NODE_ENV=production` and refuses to start without `ENCRYPTION_KEY` and `SESSION_SECRET`.

## Setup

### 1. Deploy the server

Deploy behind a reverse proxy (nginx, Caddy, Traefik) with TLS. Claude.ai requires HTTPS.

### 2. Create an account and add email credentials

1. Log in as `admin` — the initial password is printed once in the container log on first start
   (`docker logs imap-bridge`). Change it right away via **Change Password**.
   Self-service sign-up at `/signup` is disabled unless `ALLOW_SIGNUP=true` is set.
2. Go to the Dashboard and click **Add Email Account**
3. Enter your IMAP server details and credentials (use an App Password for Gmail/Outlook)
4. Optionally add SMTP settings for sending

### 3. Connect from Claude.ai

1. Go to [Claude.ai Settings > Integrations](https://claude.ai/settings/integrations)
2. Click **Add Custom Connector** (or **Add MCP Server**)
3. Enter your server URL: `https://your-domain.com/mcp`
4. Claude.ai will automatically:
   - Discover OAuth endpoints via `/.well-known/oauth-authorization-server`
   - Register itself as an OAuth client (Dynamic Client Registration)
   - Redirect you to the consent screen
5. On the consent screen, select which email account and permissions to grant
6. After authorizing, Claude.ai can use the email tools

## OAuth 2.1 Flow

```
Claude.ai                          IMAP Bridge                    User
   │                                    │                           │
   │  GET /.well-known/oauth-           │                           │
   │  authorization-server              │                           │
   │───────────────────────────────────>│                           │
   │  { endpoints, scopes }            │                           │
   │<───────────────────────────────────│                           │
   │                                    │                           │
   │  POST /oauth/register             │                           │
   │  { redirect_uris }                │                           │
   │───────────────────────────────────>│                           │
   │  { client_id }                    │                           │
   │<───────────────────────────────────│                           │
   │                                    │                           │
   │  Redirect to /oauth/authorize      │                           │
   │  + PKCE code_challenge             │                           │
   │───────────────────────────────────>│  Login form               │
   │                                    │──────────────────────────>│
   │                                    │  Username + password      │
   │                                    │<──────────────────────────│
   │                                    │  Consent screen           │
   │                                    │  (select account + perms) │
   │                                    │──────────────────────────>│
   │                                    │  Approve                  │
   │                                    │<──────────────────────────│
   │  Callback with auth code          │                           │
   │<───────────────────────────────────│                           │
   │                                    │                           │
   │  POST /oauth/token                │                           │
   │  + code_verifier (PKCE)           │                           │
   │───────────────────────────────────>│                           │
   │  { access_token, refresh_token }  │                           │
   │<───────────────────────────────────│                           │
   │                                    │                           │
   │  POST /mcp (tool calls)           │                           │
   │  Authorization: Bearer <token>    │                           │
   │───────────────────────────────────>│  IMAP                    │
   │  { tool results }                 │                           │
   │<───────────────────────────────────│                           │
```

## MCP Tools

| Tool | Scope Required | Description |
|------|---------------|-------------|
| `list_folders` | `mail:folders` | List all mailbox folders |
| `list_messages` | `mail:read` | List messages with pagination. Supports `includeBody` to fetch message content inline. |
| `read_message` | `mail:read` | Read full message by UID: decoded text body (HTML-only mails converted to text), attachment list, reply-to/references. Supports `uids` to batch-read up to 10 messages. Does not mark messages as read. |
| `search_messages` | `mail:search` | Search by sender, date, subject, body. Supports `includeBody` to fetch message content inline. |
| `move_message` | `mail:modify` | Move message between folders |
| `flag_message` | `mail:modify` | Set read/unread, star, delete flags |
| `send_mail` | `mail:send` | Send email via SMTP (CC/BCC, threading via `inReplyTo`); a copy is stored in the Sent folder |

## Development

```bash
npm install
npm run dev     # starts with tsx watch
```

```bash
npm run build   # compile TypeScript
npm start       # run compiled output
```

## Security Notes

- **HTTPS required** for production — Claude.ai will not connect over plain HTTP
- **App Passwords** — use app-specific passwords for Gmail, Outlook, etc. rather than your main password
- **Encryption key** — keep your `ENCRYPTION_KEY` safe; losing it means stored IMAP passwords become unrecoverable
- **Token revocation** — users can revoke agent tokens from the dashboard at any time
- **PKCE enforced** — all OAuth flows require Proof Key for Code Exchange (S256)
- **Content Security Policy** — restrictive CSP prevents XSS and framing attacks
- **Token refresh** — access tokens expire after 1 hour; MCP clients automatically refresh using the refresh token (30-day lifetime, single use / rotated)
- **Hashed tokens** — access/refresh tokens and authorization codes are stored only as SHA-256 hashes
- **CSRF protection & rate limiting** — all web forms carry CSRF tokens; login, token and client-registration endpoints are rate limited
- **Session binding** — an MCP session can only be used by the user/account/client that created it; idle sessions expire after 30 minutes
- **SMTP** — with TLS enabled, STARTTLS is required (no silent downgrade to plain text)

## Changelog

### 1.2.0
- Security: hashed tokens/codes, atomic code redemption and refresh rotation, CSRF tokens, login/registration
  rate limits, session fixation fix, MCP sessions bound to their owner, sign-up off by default,
  `NODE_ENV=production` in the image (enforces keys), stricter redirect URI rules, SMTP `requireTLS`,
  persistent SQLite session store, revoking tokens when an account is deleted, Deny button and redirect host on
  the consent screen, RFC 9728 protected-resource metadata.
- Mail: proper MIME decoding (charsets, base64/quoted-printable, HTML-only mails), attachment list,
  reading no longer marks mails as read, sent mails are stored in the Sent folder, BCC/References support.
- Stability: IMAP connection errors no longer crash the process, connection pool deduplication,
  tool errors returned as MCP tool errors, graceful shutdown, healthcheck, Node 24, all dependencies updated
  (0 known vulnerabilities).

## License

MIT
