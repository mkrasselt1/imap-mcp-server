import { createHash, timingSafeEqual } from "crypto";

/** RFC 7636: S256 challenge = BASE64URL(SHA256(verifier)), 43 chars. */
export const CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;
const CODE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

export function verifyPKCE(codeVerifier: string, codeChallenge: string): boolean {
  if (typeof codeVerifier !== "string" || !CODE_VERIFIER_RE.test(codeVerifier)) return false;
  const hash = Buffer.from(createHash("sha256").update(codeVerifier).digest("base64url"));
  const expected = Buffer.from(codeChallenge);
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}
