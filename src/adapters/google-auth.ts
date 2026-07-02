/**
 * src/adapters/google-auth.ts — GOOGLE API AUTH (the capability half).
 *
 * Given an authenticated userId, produces an authorized OAuth2 client for
 * calling Gmail/Calendar on that user's behalf. It reads the user's stored
 * Google credential from the UserStore (written at login by GoogleLogin) and
 * persists rotated tokens back atomically.
 *
 * Reworked for multi-user: keyed by `userId` (Google sub), not the old
 * per-"session" token bag. The class name is kept as `GoogleAuth` so the Gmail
 * and Calendar adapters — which only ever call `clientFor(id)` — are unchanged.
 *
 * googleapis lives here and in the concrete adapters only.
 */

import { google } from "googleapis";
import { UserStore } from "../auth/stores";

type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

export interface GoogleAuthConfig {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
}

export class GoogleAuth {
    constructor(
        private cfg: GoogleAuthConfig,
        private users: UserStore
    ) {
        if (!cfg.clientId || !cfg.clientSecret || !cfg.redirectUri) {
            throw new Error(
                "GoogleAuth: missing clientId/clientSecret/redirectUri."
            );
        }
    }

    private baseClient(): OAuth2Client {
        return new google.auth.OAuth2(
            this.cfg.clientId,
            this.cfg.clientSecret,
            this.cfg.redirectUri
        );
    }

    /** Has this user connected Google (i.e. do we hold a refresh token)? */
    async isConnected(userId: string): Promise<boolean> {
        const user = await this.users.getUser(userId);
        return Boolean(user?.google?.refresh_token);
    }

    /** Does the user's granted scope set include a given scope? */
    async hasScope(userId: string, scope: string): Promise<boolean> {
        const user = await this.users.getUser(userId);
        return Boolean(user?.google?.scopes?.includes(scope));
    }

    /**
     * Authorized client for this user. Throws NotConnectedError if they haven't
     * linked Google — the executor catches that and tells them to connect. The
     * client auto-refreshes the access token; we persist rotations back.
     */
    async clientFor(userId: string): Promise<OAuth2Client> {
        const user = await this.users.getUser(userId);
        const cred = user?.google;
        if (!cred?.refresh_token) {
            throw new NotConnectedError(userId);
        }

        const client = this.baseClient();
        client.setCredentials({
            refresh_token: cred.refresh_token,
            access_token: cred.access_token ?? undefined,
            expiry_date: cred.expiry_date ?? undefined,
        });

        client.on("tokens", (fresh) => {
            this.users
                .mergeGoogleTokens(userId, {
                    access_token: fresh.access_token ?? undefined,
                    expiry_date: fresh.expiry_date ?? undefined,
                    refresh_token: fresh.refresh_token ?? undefined,
                    scopes:
                        typeof fresh.scope === "string"
                            ? fresh.scope.split(" ")
                            : undefined,
                })
                .catch((e) =>
                    console.error("[google-auth] failed to persist refreshed tokens:", e)
                );
        });

        return client;
    }
}

/** Thrown when a user tries to use Google before linking an account. */
export class NotConnectedError extends Error {
    constructor(public userId: string) {
        super(`Google account not connected for user "${userId}".`);
        this.name = "NotConnectedError";
    }
}