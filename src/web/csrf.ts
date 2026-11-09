import { randomBytes, timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction } from "express";

/** Synchronizer-token CSRF protection for the cookie-authenticated web UI. */
export function csrfToken(req: Request): string {
  if (!req.session.csrfToken) {
    req.session.csrfToken = randomBytes(24).toString("hex");
  }
  return req.session.csrfToken;
}

export function csrfField(req: Request): string {
  return `<input type="hidden" name="_csrf" value="${csrfToken(req)}">`;
}

export function verifyCsrf(req: Request, res: Response, next: NextFunction) {
  const expected = req.session.csrfToken;
  const given = typeof req.body?._csrf === "string" ? req.body._csrf : "";
  if (!expected || given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
    return res.status(403).send("Invalid or missing CSRF token — please reload the page and try again.");
  }
  next();
}
