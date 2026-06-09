/**
 * src/middleware/rateLimit.ts — a small per-user request limiter.
 *
 * The vision loop polls fast (down to ~700ms while actively watching) and every
 * /api/vision and /api/orchestrate call costs a Gemini request. The client has a
 * cheap 32x32 frame-diff gate, but the client is UNTRUSTED — a tweaked or buggy
 * client can hammer these endpoints straight into the model. This caps the spend
 * per authenticated user.
 *
 * IN-MEMORY, so the counter is PER INSTANCE: with multiple Cloud Run instances a
 * user could exceed the limit by roughly the instance count. That's an acceptable
 * MVP ceiling (it still bounds runaway cost by a constant factor); a Firestore-
 * or Redis-backed counter is the multi-instance upgrade. Keyed by req.userId, so
 * it MUST run after attachUser + requireAuth on authenticated routes.
 */

import { Request, Response, NextFunction } from "express";

interface Bucket {
    count: number;
    resetAt: number;
}

export interface RateLimitOptions {
    /** Max requests allowed per window, per user. */
    max: number;
    /** Window length in milliseconds. */
    windowMs: number;
    /** Name used in logs / the 429 message. */
    name?: string;
}

export function rateLimitPerUser(opts: RateLimitOptions) {
    const { max, windowMs, name = "endpoint" } = opts;
    const buckets = new Map<string, Bucket>();

    // Periodically drop stale buckets so the map can't grow unbounded.
    const sweep = setInterval(() => {
        const now = Date.now();
        for (const [key, b] of buckets) {
            if (b.resetAt <= now) buckets.delete(key);
        }
    }, windowMs);
    // Don't keep the process alive just for the sweep.
    if (typeof sweep.unref === "function") sweep.unref();

    return function rateLimit(req: Request, res: Response, next: NextFunction): void {
        // requireAuth should have run already; fall back defensively if not.
        const key = req.userId ?? "anon";
        const now = Date.now();
        let bucket = buckets.get(key);

        if (!bucket || bucket.resetAt <= now) {
            bucket = { count: 0, resetAt: now + windowMs };
            buckets.set(key, bucket);
        }

        bucket.count++;
        if (bucket.count > max) {
            const retryMs = Math.max(0, bucket.resetAt - now);
            res.setHeader("Retry-After", String(Math.ceil(retryMs / 1000)));
            res.status(429).json({
                error: `Too many ${name} requests. Slow down and try again in a moment.`,
            });
            return;
        }
        next();
    };
}