import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TokenContext } from "../types.js";

export interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  /** Latest token context of this session (updated on every request, e.g. after a token refresh). */
  ctx: TokenContext;
  lastSeen: number;
}

/** A session may only be used by the same user, for the same mail account, from the same client. */
export function sameOwner(a: TokenContext, b: TokenContext): boolean {
  return a.userId === b.userId && a.accountId === b.accountId && a.clientId === b.clientId;
}

export const MAX_SESSIONS = 500;
export const SESSION_IDLE_MS = 30 * 60 * 1000;

export const mcpSessions = new Map<string, McpSession>();

export async function closeSession(id: string): Promise<void> {
  const s = mcpSessions.get(id);
  if (!s) return;
  mcpSessions.delete(id);
  try {
    await s.transport.close();
    await s.server.close();
  } catch {
    // already closed
  }
}

/** Drop sessions of clients that vanished without sending DELETE (prevents unbounded memory growth). */
export function startSessionSweeper(): NodeJS.Timeout {
  return setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, s] of mcpSessions) {
      if (s.lastSeen < cutoff) void closeSession(id);
    }
  }, 60 * 1000).unref();
}
