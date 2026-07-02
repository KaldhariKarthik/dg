/**
 * src/auth/middleware.ts — the REQUEST-TIME identity layer.
 *
 * `attachUser` runs on every request: it reads the session cookie, resolves it
 * server-side, and attaches a TRUSTED `req.userId`. Nothing the client sends in
 * a body is ever trusted for identity again.
 *
 * `requireAuth` gates protected routes (401 if not logged in).
 *
 * Cookie design: an opaque session id in an httpOnly cookie. Because sessions
 * are validated server-side, the cookie isn't signed — a forged/tampered id
 * simply fails to resolve. httpOnly keeps JS from reading it; SameSite=Lax +
 * POST-for-mutations covers basic CSRF; Secure is on in production.
 */

import { Request, Response, NextFunction } from "express";
import { SessionStore } from "./stores";
import { Session } from "./types";

export const SESSION_COOKIE = "dv_session";
export const OAUTH_STATE_COOKIE = "dv_oauth_state";

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            /** Authenticated user id (Google sub), set by attachUser. */
            userId?: string;
            session?: Session;
        }
    }
}

const isProd = process.env.NODE_ENV === "production";

/** Parse a single cookie out of the raw Cookie header (no cookie-parser dep). */
export function readCookie(req: Request, name: string): string | null {
    const header = req.headers.cookie;
    if (!header) return null;
    for (const part of header.split(";")) {
        const idx = part.indexOf("=");
        if (idx === -1) continue;
        const k = part.slice(0, idx).trim();
        if (k === name) return decodeURIComponent(part.slice(idx + 1).trim());
    }
    return null;
}

export function setSessionCookie(res: Response, sessionId: string): void {
    res.cookie(SESSION_COOKIE, sessionId, {
        httpOnly: true,
        secure: isProd,
        sameSite: "lax",
        path: "/",
        maxAge: 1000 * 60 * 60 * 24 * 14, // 14 days
    });
}

export function clearSessionCookie(res: Response): void {
    res.clearCookie(SESSION_COOKIE, { path: "/" });
}

export function setOAuthStateCookie(res: Response, state: string): void {
    res.cookie(OAUTH_STATE_COOKIE, state, {
        httpOnly: true,
        secure: isProd,
        sameSite: "lax",
        path: "/",
        maxAge: 1000 * 60 * 10, // 10 minutes — just long enough to complete consent
    });
}

export function clearOAuthStateCookie(res: Response): void {
    res.clearCookie(OAUTH_STATE_COOKIE, { path: "/" });
}

/**
 * Factory: build the attachUser middleware bound to a SessionStore. Non-fatal —
 * if there's no cookie or it doesn't resolve, the request simply proceeds
 * unauthenticated and requireAuth (where used) handles rejection.
 */
export function makeAttachUser(sessions: SessionStore) {
    return async function attachUser(
        req: Request,
        _res: Response,
        next: NextFunction
    ): Promise<void> {
        try {
            const sid = readCookie(req, SESSION_COOKIE);
            if (sid) {
                const session = await sessions.resolve(sid);
                if (session) {
                    req.userId = session.userId;
                    req.session = session;
                    sessions.touch(sid).catch(() => { }); // best-effort
                }
            }
        } catch (e) {
            console.error("[auth] attachUser error:", e);
        }
        next();
    };
}

/** Gate: 401 unless a user is authenticated. */
export function requireAuth(
    req: Request,
    res: Response,
    next: NextFunction
): void {
    if (!req.userId) {
        res.status(401).json({ error: "Not authenticated." });
        return;
    }
    next();
}