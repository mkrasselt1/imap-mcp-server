import express from "express";
import cors from "cors";
import session from "express-session";
import { randomUUID } from "crypto";

import { config } from "./config.js";
import { getDb } from "./db/database.js";
import { ensureDefaultUser } from "./auth/users.js";

import metadataRouter from "./oauth/metadata.js";
import registerRouter from "./oauth/register.js";
import authorizeRouter from "./oauth/authorize.js";
import tokenRouter from "./oauth/token.js";
import { bearerAuth } from "./oauth/middleware.js";

import webRouter from "./web/routes.js";
import { createMcpServer } from "./mcp/server.js";
import { setSessionContext, deleteSessionContext } from "./mcp/context.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import "./types.js";

const app = express();

// Middleware
app.use(cors({
  origin: true,
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 },
}));

// Initialize DB
getDb();
ensureDefaultUser();

// OAuth endpoints
app.use(metadataRouter);
app.use(registerRouter);
app.use(authorizeRouter);
app.use(tokenRouter);

// Web UI
app.use(webRouter);

// MCP sessions: sessionId -> { transport, server }
const mcpSessions = new Map<string, {
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof createMcpServer>;
}>();

// MCP endpoint with OAuth protection
app.post("/mcp", bearerAuth as any, async (req: any, res: any) => {
  const existingSessionId = req.headers["mcp-session-id"] as string | undefined;

  if (existingSessionId && mcpSessions.has(existingSessionId)) {
    const { transport } = mcpSessions.get(existingSessionId)!;
    setSessionContext(existingSessionId, req.tokenContext!);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  // New MCP session — create per-session server + transport
  const sessionId = randomUUID();
  setSessionContext(sessionId, req.tokenContext!);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => sessionId,
    onsessioninitialized: (sid) => {
      mcpSessions.set(sid, { transport, server });
    },
    onsessionclosed: (sid) => {
      mcpSessions.delete(sid);
      deleteSessionContext(sid);
    },
  });

  const server = createMcpServer(sessionId);
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", bearerAuth as any, async (req: any, res: any) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !mcpSessions.has(sessionId)) {
    return res.status(400).json({ error: "No active session" });
  }
  const { transport } = mcpSessions.get(sessionId)!;
  setSessionContext(sessionId, req.tokenContext!);
  await transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && mcpSessions.has(sessionId)) {
    const { transport, server } = mcpSessions.get(sessionId)!;
    await transport.handleRequest(req, res);
    await server.close();
    mcpSessions.delete(sessionId);
    deleteSessionContext(sessionId);
  } else {
    res.status(200).end();
  }
});

app.listen(config.port, () => {
  console.log(`IMAP Bridge running at ${config.baseUrl}`);
  console.log(`MCP endpoint: ${config.baseUrl}/mcp`);
  console.log(`OAuth metadata: ${config.baseUrl}/.well-known/oauth-authorization-server`);
});
