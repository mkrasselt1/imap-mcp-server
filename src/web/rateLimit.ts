import type { Request, Response, NextFunction } from "express";

/**
 * Small in-memory fixed-window rate limiter (single instance deployment, no extra dependency).
 * key() decides what is counted, e.g. client IP or IP + username.
 */
export function rateLimit(opts: {
  windowMs: number;
  max: number;
  key?: (req: Request) => string;
  message?: string;
}) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  const keyFn = opts.key ?? ((req: Request) => req.ip || "unknown");

  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, opts.windowMs).unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = keyFn(req);
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + opts.windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    if (entry.count > opts.max) {
      res.setHeader("Retry-After", Math.ceil((entry.resetAt - now) / 1000));
      return res.status(429).send(opts.message ?? "Too many requests, please try again later.");
    }
    next();
  };
}
