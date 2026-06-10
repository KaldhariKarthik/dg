"use strict";
/**
 * src/auth/googleOAuth.ts — GOOGLE LOGIN (identity + capability consent).
 *
 * This owns the LOGIN half of Google: it sends the user to Google's consent
 * screen (asking up-front for identity AND Gmail/Calendar — one consent), then
 * on callback exchanges the code, VERIFIES the ID token, and hands back the
 * verified identity plus the Google credential to store.
 *
 * The OTHER half — using the stored credential to call Gmail/Calendar APIs —
 * lives in src/adapters/google-auth.ts. Both share the same OAuth2 config.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GoogleLogin = exports.GOOGLE_SCOPES = void 0;
const googleapis_1 = require("googleapis");
/**
 * Up-front scope set (spec: request Gmail + Calendar at login). `openid email
 * profile` give us the verified identity; the rest are capabilities the
 * executor uses. Non-Google apps (Spotify, ...) are NOT here — they're separate
 * integrations with their own consent.
 */
exports.GOOGLE_SCOPES = [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/drive.readonly",
];
class GoogleLogin {
    cfg;
    constructor(cfg) {
        this.cfg = cfg;
        if (!cfg.clientId || !cfg.clientSecret || !cfg.redirectUri) {
            throw new Error("GoogleLogin: missing clientId/clientSecret/redirectUri " +
                "(set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI).");
        }
    }
    client() {
        return new googleapis_1.google.auth.OAuth2(this.cfg.clientId, this.cfg.clientSecret, this.cfg.redirectUri);
    }
    /**
     * Step 1: the URL we send the user to. `state` is an anti-CSRF nonce the
     * server also stores in a short-lived cookie and re-checks on callback.
     * offline + consent guarantees a refresh_token on first login.
     */
    consentUrl(state) {
        return this.client().generateAuthUrl({
            access_type: "offline",
            prompt: "consent",
            scope: exports.GOOGLE_SCOPES,
            state,
            include_granted_scopes: true,
        });
    }
    /**
     * Step 2: exchange the code, verify the ID token, return the verified
     * identity + the Google credential to persist. Throws if verification fails.
     */
    async handleCallback(code) {
        const client = this.client();
        const { tokens } = await client.getToken(code);
        if (!tokens.id_token) {
            throw new Error("Google did not return an id_token.");
        }
        const ticket = await client.verifyIdToken({
            idToken: tokens.id_token,
            audience: this.cfg.clientId,
        });
        const payload = ticket.getPayload();
        if (!payload?.sub) {
            throw new Error("Google ID token had no subject.");
        }
        const credential = {
            refresh_token: tokens.refresh_token ?? null,
            access_token: tokens.access_token ?? null,
            expiry_date: tokens.expiry_date ?? null,
            scopes: typeof tokens.scope === "string" ? tokens.scope.split(" ") : [],
            connectedAt: new Date().toISOString(),
        };
        return {
            userId: payload.sub,
            email: payload.email ?? "",
            displayName: payload.name ?? payload.email ?? "Unknown",
            google: credential,
        };
    }
}
exports.GoogleLogin = GoogleLogin;
//# sourceMappingURL=googleOAuth.js.map