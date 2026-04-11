export const config = {
  baseUrl: process.env.BASE_URL || "http://localhost:3000",
  port: parseInt(process.env.PORT || "3000", 10),
  encryptionKey: process.env.ENCRYPTION_KEY || "0".repeat(64),
  sessionSecret: process.env.SESSION_SECRET || "dev-session-secret",
};
