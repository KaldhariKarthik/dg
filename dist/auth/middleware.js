"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.OAUTH_STATE_COOKIE = exports.SESSION_COOKIE = void 0;
exports.readCookie = readCookie;
exports.setSessionCookie = setSessionCookie;
exports.clearSessionCookie = clearSessionCookie;
exports.setOAuthStateCookie = setOAuthStateCookie;
exports.clearOAuthStateCookie = clearOAuthStateCookie;
exports.makeAttachUser = makeAttachUser;
exports.requireAuth = requireAuth;
exports.SESSION_COOKIE = "dv_session";
exports.OAUTH_STATE_COOKIE = "dv_oauth_state";
const isProd = process.env.NODE_ENV === "production";
/** Parse a single cookie out of the raw Cookie header (no cookie-parser dep). */
function readCookie(req, name) {
    const header = req.headers.cookie;
    if (!header)
        return null;
    for (const part of header.split(";")) {
        const idx = part.indexOf("=");
        if (idx === -1)
            continue;
        const k = part.slice(0, idx).trim();
        if (k === name)
            return decodeURIComponent(part.slice(idx + 1).trim());
    }
    return null;
}
function setSessionCookie(res, sessionId) {
    res.cookie(exports.SESSION_COOKIE, sessionId, {
        httpOnly: true,
        secure: isProd,
        sameSite: "lax",
        path: "/",
        maxAge: 1000 * 60 * 60 * 24 * 14, // 14 days
    });
}
function clearSessionCookie(res) {
    res.clearCookie(exports.SESSION_COOKIE, { path: "/" });
}
function setOAuthStateCookie(res, state) {
    res.cookie(exports.OAUTH_STATE_COOKIE, state, {
        httpOnly: true,
        secure: isProd,
        sameSite: "lax",
        path: "/",
        maxAge: 1000 * 60 * 10, // 10 minutes — just long enough to complete consent
    });
}
function clearOAuthStateCookie(res) {
    res.clearCookie(exports.OAUTH_STATE_COOKIE, { path: "/" });
}
/**
 * Factory: build the attachUser middleware bound to a SessionStore. Non-fatal —
 * if there's no cookie or it doesn't resolve, the request simply proceeds
 * unauthenticated and requireAuth (where used) handles rejection.
 */
function makeAttachUser(sessions) {
    return async function attachUser(req, _res, next) {
        try {
            const sid = readCookie(req, exports.SESSION_COOKIE);
            if (sid) {
                const session = await sessions.resolve(sid);
                if (session) {
                    req.userId = session.userId;
                    req.session = session;
                    sessions.touch(sid).catch(() => { }); // best-effort
                }
            }
        }
        catch (e) {
            console.error("[auth] attachUser error:", e);
        }
        next();
    };
}
/** Gate: 401 unless a user is authenticated. */
function requireAuth(req, res, next) {
    if (!req.userId) {
        res.status(401).json({ error: "Not authenticated." });
        return;
    }
    next();
}
//# sourceMappingURL=middleware.js.map