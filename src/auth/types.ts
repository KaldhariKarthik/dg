/**
 * src/auth/types.ts — the IDENTITY contract.
 *
 * These shapes are the multi-user foundation. Everything in the system is
 * ultimately keyed by `User.id`, which is the Google `sub` claim — a stable,
 * opaque, per-account id that never changes (unlike email).
 *
 * Two token tiers (see spec §2):
 *   - `google`        : the user's Google credential. Doubles as BOTH the login
 *                       identity AND the Gmail/Calendar capability, so it's a
 *                       first-class field.
 *   - `integrations`  : every NON-Google connected app (Spotify, Notion, ...)
 *                       slots in here later with zero changes to identity.
 */

/** A stored OAuth credential. `scopes` is what was ACTUALLY granted, read back
 *  from the provider — not what we requested (users can decline). */
export interface OAuthCredential {
    /** Long-lived; the key to acting on the user's behalf. Sensitive. */
    refresh_token: string | null;
    access_token?: string | null;
    expiry_date?: number | null;
    /** Scopes the provider reports as granted. */
    scopes: string[];
    connectedAt: string; // ISO
}

/** Google is special-cased because it is both login and a connected app. */
export type GoogleCredential = OAuthCredential;

/** Any future non-Google integration uses this same shape. */
export type IntegrationCredential = OAuthCredential;

export interface User {
    /** Google `sub`. The primary key for the entire system. */
    id: string;
    /** Display only. NEVER used as a key (emails change / get reassigned). */
    email: string;
    displayName: string;
    createdAt: string; // ISO
    lastSeenAt: string; // ISO
    /** Google login + Gmail/Calendar credential. null until first consent. */
    google: GoogleCredential | null;
    /** Non-Google connected apps, keyed by app name. Empty for now. */
    integrations: Record<string, IntegrationCredential>;
}

export interface Session {
    /** Opaque, high-entropy. This is what lives (server-side) behind the cookie. */
    id: string;
    userId: string;
    createdAt: string; // ISO
    expiresAt: string; // ISO
    lastUsedAt: string; // ISO
}