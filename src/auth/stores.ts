/**
 * src/auth/stores.ts — the IDENTITY persistence seams.
 *
 * Twin of src/store/store.ts, but for identity instead of working state. The
 * auth layer depends on THESE interfaces, never on Firestore or the filesystem.
 * Firestore (prod) and File (dev) implementors live in src/store/*Stores.ts and
 * are chosen by one wiring line in the factory.
 *
 * Why separate from the working-state `Store`: different lifecycle and access
 * pattern. User/session records are read on every authenticated request and
 * must be safe under concurrency; the working-state bag is the planner/vision
 * scratch space. Conflating them is how you end up loading the whole user blob
 * on every vision frame.
 */

import {
    User,
    Session,
    GoogleCredential,
    IntegrationCredential,
} from "./types";

export interface UpsertUserInput {
    /** Google sub. */
    id: string;
    email: string;
    displayName: string;
}

export interface UserStore {
    /** Fetch a user by id (Google sub). null if unknown. */
    getUser(userId: string): Promise<User | null>;

    /**
     * Create on first login, or update email/displayName/lastSeenAt on return.
     * Never touches credentials — those go through the set/merge methods so a
     * login refresh can't accidentally wipe a stored refresh_token.
     */
    upsertUser(input: UpsertUserInput): Promise<User>;

    /** Replace the Google credential (first connect, or re-consent). */
    setGoogleCredential(userId: string, cred: GoogleCredential): Promise<void>;

    /**
     * Merge freshly-rotated Google tokens (access_token/expiry) WITHOUT losing
     * the refresh_token — Google only returns a refresh_token on first consent,
     * so later rotations must preserve the stored one. Must be atomic.
     */
    mergeGoogleTokens(
        userId: string,
        tokens: Partial<GoogleCredential>
    ): Promise<void>;

    /** Connect/replace a non-Google integration credential. */
    setIntegration(
        userId: string,
        app: string,
        cred: IntegrationCredential
    ): Promise<void>;
}

export interface SessionStore {
    /** Mint a new session for a user. */
    create(userId: string, ttlMs?: number): Promise<Session>;

    /**
     * Look up a session by id. Returns null if missing OR expired (an expired
     * session is treated as gone; implementors may also delete it lazily).
     */
    resolve(sessionId: string): Promise<Session | null>;

    /** Update lastUsedAt (best-effort; failures here must not break a request). */
    touch(sessionId: string): Promise<void>;

    /** Invalidate one session (logout). */
    revoke(sessionId: string): Promise<void>;

    /** Invalidate every session for a user ("sign out everywhere"). */
    revokeAllForUser(userId: string): Promise<void>;
}