import { createHash, randomBytes } from "crypto";

/** Tokens/codes are only ever stored as SHA-256 hashes. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newToken(): string {
  return randomBytes(32).toString("hex");
}
