const isProduction = process.env.NODE_ENV === "production";

function fatal(message: string): never {
  console.error(`FATAL: ${message}`);
  process.exit(1);
}

const encryptionKey = process.env.ENCRYPTION_KEY;
const sessionSecret = process.env.SESSION_SECRET;

if (isProduction && !encryptionKey) {
  fatal(
    "ENCRYPTION_KEY must be set in production (64 hex chars, `openssl rand -hex 32`). " +
    "If this instance previously ran WITHOUT a key, set ENCRYPTION_KEY to 64 zeros to keep access to the stored passwords."
  );
}
if (encryptionKey !== undefined && !/^[0-9a-fA-F]{64}$/.test(encryptionKey)) {
  fatal("ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes). Generate with `openssl rand -hex 32`.");
}
if (!encryptionKey || /^0{64}$/.test(encryptionKey)) {
  console.warn("WARNING: ENCRYPTION_KEY is unset or all zeros — stored IMAP/SMTP passwords are effectively unencrypted!");
}

if (isProduction && !sessionSecret) {
  fatal("SESSION_SECRET must be set in production (`openssl rand -hex 32`).");
}
if (!sessionSecret) {
  console.warn("WARNING: Using default SESSION_SECRET — set SESSION_SECRET for production!");
} else if (sessionSecret.length < 32) {
  console.warn("WARNING: SESSION_SECRET is short — use at least 32 random characters (`openssl rand -hex 32`).");
}

const baseUrl = (process.env.BASE_URL || "http://localhost:3000").replace(/\/+$/, "");

export const config = {
  isProduction,
  baseUrl,
  port: parseInt(process.env.PORT || "3000", 10),
  encryptionKey: encryptionKey || "0".repeat(64),
  sessionSecret: sessionSecret || "dev-session-secret",
  corsOrigin: process.env.CORS_ORIGIN || undefined,
  /** Self-service sign-up. Off by default: the first user ("admin") is created automatically. */
  allowSignup: /^(1|true|yes)$/i.test(process.env.ALLOW_SIGNUP || ""),
  /**
   * Number of reverse-proxy hops to trust for X-Forwarded-* (client IP for rate limiting, secure cookies).
   * Default: 1 when BASE_URL is https (typical: one nginx/caddy/traefik in front), else 0.
   */
  trustProxy: process.env.TRUST_PROXY !== undefined
    ? parseInt(process.env.TRUST_PROXY, 10) || 0
    : (baseUrl.startsWith("https") ? 1 : 0),
};
