import express from "express";
import type { Request, Response, NextFunction } from "express";
import cors from "cors";
import session from "express-session";
import { randomUUID } from "crypto";

import { config } from "./config.js";
import { getDb, cleanupDb, closeDb } from "./db/database.js";
import { ensureDefaultUser } from "./auth/users.js";
import { SqliteSessionStore } from "./auth/sessionStore.js";

import metadataRouter from "./oauth/metadata.js";
import registerRouter from "./oauth/register.js";
import authorizeRouter from "./oauth/authorize.js";
import tokenRouter from "./oauth/token.js";
import { bearerAuth } from "./oauth/middleware.js";

import webRouter from "./web/routes.js";
import { rateLimit } from "./web/rateLimit.js";
import { createMcpServer } from "./mcp/server.js";
import { mcpSessions, closeSession, sameOwner, startSessionSweeper, MAX_SESSIONS } from "./mcp/context.js";
import { closeAllConnections } from "./imap/client.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import "./types.js";

const app = express();
app.disable("x-powered-by");

// Trust reverse proxy (secure cookies, real client IP for rate limiting)
app.set("trust proxy", config.trustProxy);

// Security headers
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
  if (config.baseUrl.startsWith("https")) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000");
  }
  next();
});

app.get("/healthz", (_req, res) => {
  getDb().prepare("SELECT 1").get();
  res.json({ ok: true });
});

// CORS: only the API endpoints are meant for cross-origin use, and they authenticate via
// Bearer token — never allow cookies cross-origin (the web UI uses a session cookie).
const apiCors = cors({
  origin: config.corsOrigin ? config.corsOrigin.split(",").map((s) => s.trim()) : true,
  credentials: false,
  exposedHeaders: ["Mcp-Session-Id", "WWW-Authenticate"],
});
app.use(["/mcp", "/oauth/token", "/oauth/register", "/register", "/.well-known"], apiCors);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false, limit: "100kb" }));

// Initialize DB before the session store is used
getDb();
ensureDefaultUser();
cleanupDb();
setInterval(() => {
  try { cleanupDb(); } catch (e) { console.error("Cleanup failed:", e); }
}, 60 * 60 * 1000).unref();

app.use(session({
  name: "imapbridge.sid",
  secret: config.sessionSecret,
  store: new SqliteSessionStore(),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    secure: config.baseUrl.startsWith("https") ? "auto" : false,
    httpOnly: true,
    sameSite: "lax",
    maxAge: 24 * 60 * 60 * 1000,
  },
}));

// OAuth endpoints
app.use(metadataRouter);
app.use(registerRouter);
app.use(authorizeRouter);
app.use("/oauth/token", rateLimit({ windowMs: 60 * 1000, max: 60, message: "Too many token requests" }));
app.use(tokenRouter);

// Web UI
app.use(webRouter);

// ---------------------------------------------------------------- MCP (Streamable HTTP)

const mcpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  key: (req) => req.tokenContext?.userId || req.ip || "unknown",
});

/** Look up an existing session; reject if it belongs to someone else. */
function findSession(req: Request, res: Response) {
  const sid = req.headers["mcp-session-id"];
  if (typeof sid !== "string") return { sid: undefined, session: undefined };
  const s = mcpSessions.get(sid);
  if (!s) {
    // Spec: unknown/expired session → 404, client starts a new session
    res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
    return { sid, session: null };
  }
  if (!sameOwner(s.ctx, req.tokenContext!)) {
    res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
    return { sid, session: null };
  }
  s.ctx = req.tokenContext!; // e.g. updated scopes after re-authorization
  s.lastSeen = Date.now();
  return { sid, session: s };
}

const asyncHandler = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

app.post("/mcp", bearerAuth, mcpLimiter, asyncHandler(async (req, res) => {
  const { session: existing } = findSession(req, res);
  if (existing === null) return;
  if (existing) {
    await existing.transport.handleRequest(req, res, req.body);
    return;
  }

  if (!isInitializeRequest(req.body)) {
    res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: missing Mcp-Session-Id" }, id: null });
    return;
  }
  if (mcpSessions.size >= MAX_SESSIONS) {
    res.status(503).json({ jsonrpc: "2.0", error: { code: -32000, message: "Too many active sessions" }, id: null });
    return;
  }

  const sessionId = randomUUID();
  const entry = {
    ctx: req.tokenContext!,
    lastSeen: Date.now(),
  } as any;
  const server = createMcpServer(() => entry.ctx);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => sessionId,
    onsessioninitialized: (sid) => {
      mcpSessions.set(sid, entry);
    },
    onsessionclosed: (sid) => {
      void closeSession(sid);
    },
  });
  entry.transport = transport;
  entry.server = server;
  transport.onclose = () => {
    mcpSessions.delete(sessionId);
  };

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}));

app.get("/mcp", bearerAuth, mcpLimiter, asyncHandler(async (req, res) => {
  const { session } = findSession(req, res);
  if (session === null) return;
  if (!session) {
    res.status(400).json({ error: "No active session" });
    return;
  }
  await session.transport.handleRequest(req, res);
}));

app.delete("/mcp", bearerAuth, asyncHandler(async (req, res) => {
  const { sid, session } = findSession(req, res);
  if (session === null) return;
  if (!session || !sid) {
    res.status(200).end();
    return;
  }
  await session.transport.handleRequest(req, res);
  await closeSession(sid);
}));

// Errors: never leak stack traces to clients
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  if (err?.type === "entity.too.large") {
    return res.status(413).send("Request too large");
  }
  if (err?.type === "entity.parse.failed") {
    return res.status(400).send("Malformed request body");
  }
  console.error(`Error on ${req.method} ${req.path}:`, err);
  if (res.headersSent) return;
  if (req.path === "/mcp") {
    return res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  }
  res.status(500).send("Internal server error");
});

startSessionSweeper();

const httpServer = app.listen(config.port, () => {
  console.log(`IMAP Bridge running at ${config.baseUrl}`);
  console.log(`MCP endpoint: ${config.baseUrl}/mcp`);
  console.log(`OAuth metadata: ${config.baseUrl}/.well-known/oauth-authorization-server`);
  if (config.allowSignup) console.log("Self-service sign-up is ENABLED (ALLOW_SIGNUP).");
});

// Graceful shutdown (docker stop / update)
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down...`);
  httpServer.close();
  await Promise.allSettled([...mcpSessions.keys()].map((id) => closeSession(id)));
  await closeAllConnections().catch(() => {});
  closeDb();
  process.exit(0);
}
// A single failed request/connection must never take the whole bridge down
process.on("unhandledRejection", (reason) => console.error("Unhandled rejection:", reason));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
