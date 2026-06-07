/**
 * src/adapters/google-auth.ts — THE ONLY GOOGLE-OAUTH FILE.
 *
 * Owns the OAuth2 dance and token lifecycle for ALL Google adapters (Gmail
 * now, Calendar later — they share one Google login + one set of scopes).
 *
 * Tokens are persisted through your existing Store (keyed by sessionId), so:
 *   - multi-user works: each session has its own refresh token
 *   - it survives restarts (FileStore writes them to ./data/<session>.json)
 *
 * googleapis lives here and in the concrete adapters only. Nothing else in the
 * codebase imports it.
 *
 * SECURITY NOTE: refresh tokens are sensitive. FileStore keeps them in plain
 * JSON under ./data — fine for local/dev. For production, swap Store for an
 * encrypted/Redis/Postgres implementor (the seam already exists) and serve
 * over HTTPS. Make sure ./data is gitignored (it is).
 */

import { google } from "googleapis";
import type { OAuth2Client } from "googleapis-common";
import { Store } from "../store/store";

/**
 * Scopes the whole system may use. Gmail send today; Calendar is included so
 * the user consents once and Calendar "just works" when you build it. Trim if
 * you'd rather ask for Calendar consent only when you add that adapter.
 */
export const GOOGLE_SCOPES = [
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/calendar",
];

/** Where in a session's state bag we keep Google tokens. */
const TOKEN_KEY = "googleTokens";

interface StoredGoogleTokens {
    refresh_token?: string | null;
    access_token?: string | null;
    expiry_date?: number | null;
    scope?: string | null;
    token_type?: string | null;
    id_token?: string | null;
}

export interface GoogleAuthConfig {
    clientId: string;
    clientSecret: string;
    /** Must EXACTLY match an Authorized redirect URI in the Google console. */
    redirectUri: string;
}

export class GoogleAuth {
    constructor(private cfg: GoogleAuthConfig, private store: Store) {
        if (!cfg.clientId || !cfg.clientSecret || !cfg.redirectUri) {
            throw new Error(
                "GoogleAuth: missing clientId/clientSecret/redirectUri " +
                "(set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI)."
            );
        }
    }

    /** A bare OAuth2 client with our app credentials, no user tokens attached. */
    private baseClient(): OAuth2Client {
        return new google.auth.OAuth2(
            this.cfg.clientId,
            this.cfg.clientSecret,
            this.cfg.redirectUri
        );
    }

    /**
     * Step 1 of the flow: the URL we send the user to in order to grant access.
     * `state` carries the sessionId round-trip so the callback knows whose
     * tokens it just received.
     *
     * access_type:"offline" + prompt:"consent" is what makes Google hand back a
     * REFRESH token (otherwise you only get a short-lived access token).
     */
    consentUrl(sessionId: string): string {
        return this.baseClient().generateAuthUrl({
            access_type: "offline",
            prompt: "consent",
            scope: GOOGLE_SCOPES,
            state: sessionId,
        });
    }

    /**
     * Step 2: Google redirects back with a `code`. Exchange it for tokens and
     * persist the refresh token into the session's state.
     */
    async handleCallback(sessionId: string, code: string): Promise<void> {
        const client = this.baseClient();
        const { tokens } = await client.getToken(code);

        const state = await this.store.load(sessionId);
        const prev = (state[TOKEN_KEY] as StoredGoogleTokens) ?? {};

        // Google only returns a refresh_token on the FIRST consent. Preserve any
        // existing one if a later exchange omits it.
        const merged: StoredGoogleTokens = {
            ...prev,
            ...tokens,
            refresh_token: tokens.refresh_token ?? prev.refresh_token,
        };

        state[TOKEN_KEY] = merged;
        await this.store.save(sessionId, state);
    }

    /** Has this session connected a Google account yet? */
    async isConnected(sessionId: string): Promise<boolean> {
        const state = await this.store.load(sessionId);
        const t = state[TOKEN_KEY] as StoredGoogleTokens | undefined;
        return Boolean(t?.refresh_token);
    }

    /**
     * Produce an authorized OAuth2 client for this session, ready to hand to a
     * Google API. Throws NotConnectedError if the user hasn't linked Google —
     * the executor catches that and tells the user to connect.
     *
     * The googleapis client auto-refreshes the access token from the refresh
     * token as needed; we listen for refreshes and persist them back.
     */
    async clientFor(sessionId: string): Promise<OAuth2Client> {
        const state = await this.store.load(sessionId);
        const tokens = state[TOKEN_KEY] as StoredGoogleTokens | undefined;

        if (!tokens?.refresh_token) {
            throw new NotConnectedError(sessionId);
        }

        const client = this.baseClient();
        client.setCredentials(tokens as Record<string, unknown>);

        // Persist any newly-refreshed tokens so we don't lose rotation.
        client.on("tokens", async (fresh) => {
            try {
                const s = await this.store.load(sessionId);
                const prev = (s[TOKEN_KEY] as StoredGoogleTokens) ?? {};
                s[TOKEN_KEY] = {
                    ...prev,
                    ...fresh,
                    refresh_token: fresh.refresh_token ?? prev.refresh_token,
                };
                await this.store.save(sessionId, s);
            } catch (e) {
                console.error("[google-auth] failed to persist refreshed tokens:", e);
            }
        });

        return client;
    }
}

/** Thrown when a session tries to use Google before linking an account. */
export class NotConnectedError extends Error {
    constructor(public sessionId: string) {
        super(`Google account not connected for session "${sessionId}".`);
        this.name = "NotConnectedError";
    }
}