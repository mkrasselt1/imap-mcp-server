import session from "express-session";
import { getDb } from "../db/database.js";

/**
 * express-session store backed by the existing SQLite DB.
 * Replaces the default MemoryStore (leaks memory, logs everyone out on every restart/update).
 */
export class SqliteSessionStore extends session.Store {
  private ttlMs(sess: session.SessionData): number {
    const maxAge = sess.cookie?.maxAge;
    return typeof maxAge === "number" ? maxAge : 24 * 60 * 60 * 1000;
  }

  get(sid: string, cb: (err: any, session?: session.SessionData | null) => void): void {
    try {
      const row = getDb().prepare("SELECT data, expires_at FROM sessions WHERE sid = ?").get(sid) as
        { data: string; expires_at: number } | undefined;
      if (!row || row.expires_at < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.data));
    } catch (e) {
      cb(e);
    }
  }

  set(sid: string, sess: session.SessionData, cb?: (err?: any) => void): void {
    try {
      getDb().prepare(`
        INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at
      `).run(sid, JSON.stringify(sess), Date.now() + this.ttlMs(sess));
      cb?.();
    } catch (e) {
      cb?.(e);
    }
  }

  destroy(sid: string, cb?: (err?: any) => void): void {
    try {
      getDb().prepare("DELETE FROM sessions WHERE sid = ?").run(sid);
      cb?.();
    } catch (e) {
      cb?.(e);
    }
  }

  touch(sid: string, sess: session.SessionData, cb?: (err?: any) => void): void {
    try {
      getDb().prepare("UPDATE sessions SET expires_at = ? WHERE sid = ?").run(Date.now() + this.ttlMs(sess), sid);
      cb?.();
    } catch (e) {
      cb?.(e);
    }
  }
}

/** Log a user out everywhere (e.g. after a password change), optionally keeping the current session. */
export function destroyUserSessions(userId: string, exceptSid?: string): void {
  const rows = getDb().prepare("SELECT sid, data FROM sessions").all() as { sid: string; data: string }[];
  const del = getDb().prepare("DELETE FROM sessions WHERE sid = ?");
  for (const r of rows) {
    if (r.sid === exceptSid) continue;
    try {
      if (JSON.parse(r.data).userId === userId) del.run(r.sid);
    } catch {
      del.run(r.sid);
    }
  }
}
