import { ImapFlow } from "imapflow";
import { getAccount, getAccountPassword } from "./accounts.js";

interface PoolEntry {
  client: ImapFlow;
  timer: ReturnType<typeof setTimeout>;
}

const pool = new Map<string, PoolEntry>();
// Concurrent first calls for the same account share one connection attempt
const connecting = new Map<string, Promise<ImapFlow>>();
const IDLE_TIMEOUT = 5 * 60 * 1000;

export async function getImapClient(accountId: string): Promise<ImapFlow> {
  const existing = pool.get(accountId);
  if (existing && existing.client.usable) {
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => closeConnection(accountId), IDLE_TIMEOUT);
    return existing.client;
  }
  if (existing) {
    await closeConnection(accountId);
  }

  const pending = connecting.get(accountId);
  if (pending) return pending;

  const attempt = connect(accountId).finally(() => connecting.delete(accountId));
  connecting.set(accountId, attempt);
  return attempt;
}

async function connect(accountId: string): Promise<ImapFlow> {
  const account = getAccount(accountId);
  if (!account) throw new Error("IMAP account not found");

  const client = new ImapFlow({
    host: account.imap_host,
    port: account.imap_port,
    secure: account.imap_tls === 1,
    auth: { user: account.username, pass: getAccountPassword(account) },
    logger: false,
    connectionTimeout: 30_000,
    greetingTimeout: 15_000,
    socketTimeout: 5 * 60_000,
  });

  // Without an 'error' listener a dropped connection would crash the whole process
  client.on("error", (err: Error) => {
    console.warn(`IMAP connection error (account ${accountId}): ${err.message}`);
    void closeConnection(accountId);
  });
  client.on("close", () => {
    const entry = pool.get(accountId);
    if (entry?.client === client) {
      clearTimeout(entry.timer);
      pool.delete(accountId);
    }
  });

  try {
    await client.connect();
  } catch (e: any) {
    // Never leak server responses that might echo credentials; keep the message short
    throw new Error(`IMAP login/connection failed: ${e?.responseText || e?.message || "unknown error"}`);
  }

  const timer = setTimeout(() => closeConnection(accountId), IDLE_TIMEOUT);
  pool.set(accountId, { client, timer });
  return client;
}

export async function closeConnection(accountId: string): Promise<void> {
  const entry = pool.get(accountId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pool.delete(accountId);
  try {
    await entry.client.logout();
  } catch {
    entry.client.close();
  }
}

export async function closeAllConnections(): Promise<void> {
  await Promise.all([...pool.keys()].map((id) => closeConnection(id)));
}
