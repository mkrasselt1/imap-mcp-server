import { randomBytes, scryptSync, timingSafeEqual, createHash, randomUUID } from "crypto";
import { getDb } from "../db/database.js";
import type { User } from "../types.js";

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function isLegacyHash(storedHash: string): boolean {
  return !storedHash.includes(":");
}

function verifyPassword(password: string, storedHash: string): boolean {
  // Legacy unsalted SHA-256 hashes (upgraded to scrypt on the next successful login)
  if (isLegacyHash(storedHash)) {
    const supplied = createHash("sha256").update(password).digest();
    const stored = Buffer.from(storedHash, "hex");
    return supplied.length === stored.length && timingSafeEqual(supplied, stored);
  }
  const [salt, hash] = storedHash.split(":");
  const hashBuffer = Buffer.from(hash, "hex");
  const supplied = scryptSync(password, salt, 64);
  return hashBuffer.length === supplied.length && timingSafeEqual(hashBuffer, supplied);
}

// Used to spend the same scrypt time for unknown usernames (no user enumeration via timing)
const DUMMY_HASH = hashPassword(randomBytes(16).toString("hex"));

export function createUser(username: string, password: string): User {
  const db = getDb();
  const id = randomUUID();
  const password_hash = hashPassword(password);
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)").run(id, username, password_hash);
  return { id, username, password_hash, created_at: new Date().toISOString() };
}

export function verifyUser(username: unknown, password: unknown): User | null {
  if (typeof username !== "string" || typeof password !== "string" || password.length > 1024) return null;
  const db = getDb();
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username) as User | undefined;
  if (!user) {
    verifyPassword(password, DUMMY_HASH);
    return null;
  }
  if (!verifyPassword(password, user.password_hash)) return null;
  if (isLegacyHash(user.password_hash)) {
    changePassword(user.id, password);
  }
  return user;
}

export function getUserById(id: string): User | null {
  return (getDb().prepare("SELECT * FROM users WHERE id = ?").get(id) as User) || null;
}

export function changePassword(userId: string, newPassword: string): void {
  getDb().prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(newPassword), userId);
}

export function ensureDefaultUser(): void {
  const count = getDb().prepare("SELECT COUNT(*) as c FROM users").get() as { c: number };
  if (count.c === 0) {
    const password = randomBytes(16).toString("base64url");
    createUser("admin", password);
    console.log("========================================");
    console.log("  Default user created:");
    console.log(`  Username: admin`);
    console.log(`  Password: ${password}`);
    console.log("  CHANGE THIS PASSWORD IMMEDIATELY!");
    console.log("========================================");
  }
}
