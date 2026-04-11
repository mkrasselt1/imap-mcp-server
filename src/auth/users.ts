import { createHash } from "crypto";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/database.js";
import type { User } from "../types.js";

function hashPassword(password: string): string {
  return createHash("sha256").update(password).digest("hex");
}

export function createUser(username: string, password: string): User {
  const db = getDb();
  const id = uuid();
  const password_hash = hashPassword(password);
  db.prepare(
    "INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)"
  ).run(id, username, password_hash);
  return { id, username, password_hash, created_at: new Date().toISOString() };
}

export function verifyUser(username: string, password: string): User | null {
  const db = getDb();
  const user = db
    .prepare("SELECT * FROM users WHERE username = ?")
    .get(username) as User | undefined;
  if (!user) return null;
  const hash = hashPassword(password);
  if (hash !== user.password_hash) return null;
  return user;
}

export function getUserById(id: string): User | null {
  const db = getDb();
  return (db.prepare("SELECT * FROM users WHERE id = ?").get(id) as User) || null;
}

export function ensureDefaultUser(): void {
  const db = getDb();
  const count = db.prepare("SELECT COUNT(*) as c FROM users").get() as { c: number };
  if (count.c === 0) {
    createUser("admin", "admin");
    console.log("Created default user: admin / admin");
  }
}
