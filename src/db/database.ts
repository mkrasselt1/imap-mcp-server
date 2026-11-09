import Database from "better-sqlite3";
import { join } from "path";
import { mkdirSync } from "fs";
import { hashToken } from "../oauth/tokenHash.js";

let db: Database.Database;

const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS imap_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  imap_host TEXT NOT NULL,
  imap_port INTEGER NOT NULL DEFAULT 993,
  imap_tls INTEGER NOT NULL DEFAULT 1,
  username TEXT NOT NULL,
  password_encrypted TEXT NOT NULL,
  password_iv TEXT NOT NULL,
  smtp_host TEXT,
  smtp_port INTEGER DEFAULT 587,
  smtp_tls INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT,
  redirect_uris TEXT NOT NULL,
  grant_types TEXT NOT NULL,
  response_types TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
  user_id TEXT NOT NULL REFERENCES users(id),
  account_id TEXT NOT NULL REFERENCES imap_accounts(id),
  redirect_uri TEXT NOT NULL,
  scopes TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id TEXT PRIMARY KEY,
  access_token TEXT UNIQUE NOT NULL,
  refresh_token TEXT UNIQUE,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  scopes TEXT NOT NULL,
  access_token_expires_at TEXT NOT NULL,
  refresh_token_expires_at TEXT,
  revoked INTEGER DEFAULT 0
);
`;

/** Versioned migrations (PRAGMA user_version). Each runs exactly once, inside a transaction. */
const MIGRATIONS: ((db: Database.Database) => void)[] = [
  // 1: tokens & codes stored as SHA-256 hashes (a DB leak no longer exposes usable tokens),
  //    persistent web sessions, indexes.
  (db) => {
    const tokens = db.prepare("SELECT id, access_token, refresh_token FROM oauth_tokens").all() as
      { id: string; access_token: string; refresh_token: string | null }[];
    const updToken = db.prepare("UPDATE oauth_tokens SET access_token = ?, refresh_token = ? WHERE id = ?");
    for (const t of tokens) {
      updToken.run(hashToken(t.access_token), t.refresh_token ? hashToken(t.refresh_token) : null, t.id);
    }
    const codes = db.prepare("SELECT code FROM oauth_codes").all() as { code: string }[];
    const updCode = db.prepare("UPDATE oauth_codes SET code = ? WHERE code = ?");
    for (const c of codes) {
      updCode.run(hashToken(c.code), c.code);
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_tokens_user ON oauth_tokens(user_id);
      CREATE INDEX IF NOT EXISTS idx_tokens_account ON oauth_tokens(account_id);
      CREATE INDEX IF NOT EXISTS idx_imap_accounts_user ON imap_accounts(user_id);
    `);
  },
];

export function getDb(): Database.Database {
  if (!db) {
    const dataDir = join(process.cwd(), "data");
    mkdirSync(dataDir, { recursive: true });
    db = new Database(join(dataDir, "bridge.db"));
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    db.exec(BASE_SCHEMA);
    migrate(db);
  }
  return db;
}

function migrate(db: Database.Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      MIGRATIONS[v](db);
      db.pragma(`user_version = ${v + 1}`);
    })();
    console.log(`Database migrated to version ${v + 1}`);
  }
}

/** Remove expired/used OAuth artifacts, stale sessions and never-used client registrations. */
export function cleanupDb(): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("DELETE FROM oauth_codes WHERE expires_at < ? OR used = 1").run(now);
  db.prepare(`
    DELETE FROM oauth_tokens
    WHERE (refresh_token_expires_at IS NOT NULL AND refresh_token_expires_at < ?)
       OR (refresh_token_expires_at IS NULL AND access_token_expires_at < ?)
       OR (revoked = 1 AND access_token_expires_at < ?)
  `).run(now, now, new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
  // Dynamic client registrations that never received a token within 7 days (registration spam)
  db.prepare(`
    DELETE FROM oauth_clients
    WHERE created_at < datetime('now', '-7 days')
      AND client_id NOT IN (SELECT client_id FROM oauth_tokens)
      AND client_id NOT IN (SELECT client_id FROM oauth_codes)
  `).run();
}

export function closeDb(): void {
  db?.close();
}
