/**
 * src/store/backends/firestore.ts — ALL Firestore-backed implementors (PROD).
 *
 *   FirestoreUserStore     -> users/{userId}
 *   FirestoreSessionStore  -> sessions/{sessionId}
 *   FirestoreWorkingStore  -> working/{userId}
 *   FirestoreMemoryStore   -> memory/{userId}
 *
 * Concurrency: mergeGoogleTokens (the one place a lost update would drop a
 * refresh_token) uses a transaction. Working-state keeps load/save semantics
 * for now; atomic per-field plan updates come in the planner step.
 */

import * as admin from "firebase-admin";
import { Store } from "../store";
import { MemoryStore, MemoryData, emptyMemory, applyMemoryDelta } from "../memoryStore";
import { newSessionId } from "../ids";
import { UserStore, SessionStore, UpsertUserInput } from "../../auth/stores";
import { User, Session, GoogleCredential, IntegrationCredential } from "../../auth/types";

const DEFAULT_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

function nowIso(): string {
    return new Date().toISOString();
}

/* ----------------------------------- USERS ----------------------------------- */

export class FirestoreUserStore implements UserStore {
    private col: admin.firestore.CollectionReference;
    constructor(private db: admin.firestore.Firestore) {
        this.col = db.collection("users");
    }

    async getUser(userId: string): Promise<User | null> {
        const snap = await this.col.doc(userId).get();
        if (!snap.exists) return null;
        return this.hydrate(userId, snap.data() ?? {});
    }

    async upsertUser(input: UpsertUserInput): Promise<User> {
        const ref = this.col.doc(input.id);
        const ts = nowIso();
        return this.db.runTransaction(async (t) => {
            const snap = await t.get(ref);
            if (snap.exists) {
                t.update(ref, {
                    email: input.email,
                    displayName: input.displayName,
                    lastSeenAt: ts,
                });
                return this.hydrate(input.id, {
                    ...(snap.data() ?? {}),
                    email: input.email,
                    displayName: input.displayName,
                    lastSeenAt: ts,
                });
            }
            const fresh = {
                email: input.email,
                displayName: input.displayName,
                createdAt: ts,
                lastSeenAt: ts,
                google: null,
                integrations: {},
            };
            t.set(ref, fresh);
            return this.hydrate(input.id, fresh);
        });
    }

    async setGoogleCredential(userId: string, cred: GoogleCredential): Promise<void> {
        await this.col.doc(userId).set({ google: cred }, { merge: true });
    }

    async mergeGoogleTokens(userId: string, tokens: Partial<GoogleCredential>): Promise<void> {
        const ref = this.col.doc(userId);
        await this.db.runTransaction(async (t) => {
            const snap = await t.get(ref);
            const prev = (snap.data()?.google ?? null) as GoogleCredential | null;
            const merged: GoogleCredential = {
                refresh_token: tokens.refresh_token ?? prev?.refresh_token ?? null,
                access_token: tokens.access_token ?? prev?.access_token ?? null,
                expiry_date: tokens.expiry_date ?? prev?.expiry_date ?? null,
                scopes: tokens.scopes ?? prev?.scopes ?? [],
                connectedAt: prev?.connectedAt ?? nowIso(),
            };
            t.set(ref, { google: merged }, { merge: true });
        });
    }

    async setIntegration(userId: string, app: string, cred: IntegrationCredential): Promise<void> {
        await this.col.doc(userId).set({ integrations: { [app]: cred } }, { merge: true });
    }

    private hydrate(id: string, d: admin.firestore.DocumentData): User {
        return {
            id,
            email: typeof d.email === "string" ? d.email : "",
            displayName: typeof d.displayName === "string" ? d.displayName : "",
            createdAt: typeof d.createdAt === "string" ? d.createdAt : nowIso(),
            lastSeenAt: typeof d.lastSeenAt === "string" ? d.lastSeenAt : nowIso(),
            google: (d.google as GoogleCredential | null) ?? null,
            integrations: (d.integrations as Record<string, IntegrationCredential>) ?? {},
        };
    }
}

/* --------------------------------- SESSIONS ---------------------------------- */

export class FirestoreSessionStore implements SessionStore {
    private col: admin.firestore.CollectionReference;
    constructor(private db: admin.firestore.Firestore) {
        this.col = db.collection("sessions");
    }

    async create(userId: string, ttlMs = DEFAULT_SESSION_TTL_MS): Promise<Session> {
        const session: Session = {
            id: newSessionId(),
            userId,
            createdAt: nowIso(),
            expiresAt: new Date(Date.now() + ttlMs).toISOString(),
            lastUsedAt: nowIso(),
        };
        await this.col.doc(session.id).set(session);
        return session;
    }

    async resolve(sessionId: string): Promise<Session | null> {
        const snap = await this.col.doc(sessionId).get();
        if (!snap.exists) return null;
        const s = snap.data() as Session;
        if (new Date(s.expiresAt).getTime() <= Date.now()) {
            this.col.doc(sessionId).delete().catch(() => { });
            return null;
        }
        return s;
    }

    async touch(sessionId: string): Promise<void> {
        await this.col.doc(sessionId).set({ lastUsedAt: nowIso() }, { merge: true });
    }

    async revoke(sessionId: string): Promise<void> {
        await this.col.doc(sessionId).delete();
    }

    async revokeAllForUser(userId: string): Promise<void> {
        const q = await this.col.where("userId", "==", userId).get();
        const batch = this.db.batch();
        q.forEach((doc) => batch.delete(doc.ref));
        await batch.commit();
    }
}

/* ------------------------------- WORKING STATE ------------------------------- */

export class FirestoreWorkingStore implements Store {
    private col: admin.firestore.CollectionReference;
    constructor(db: admin.firestore.Firestore) {
        this.col = db.collection("working");
    }

    async load(userId: string): Promise<Record<string, unknown>> {
        const snap = await this.col.doc(userId).get();
        return snap.exists ? (snap.data() ?? {}) : {};
    }

    async save(userId: string, state: Record<string, unknown>): Promise<void> {
        await this.col.doc(userId).set(state);
    }
}

/* ---------------------------------- MEMORY ----------------------------------- */

export class FirestoreMemoryStore implements MemoryStore {
    private col: admin.firestore.CollectionReference;
    constructor(private db: admin.firestore.Firestore) {
        this.col = db.collection("memory");
    }

    async loadMemory(userId: string): Promise<MemoryData> {
        const snap = await this.col.doc(userId).get();
        if (!snap.exists) return emptyMemory();
        const d = snap.data() ?? {};
        return {
            preferences: (d.preferences as Record<string, string>) ?? {},
            past_patterns: Array.isArray(d.past_patterns) ? d.past_patterns : [],
            long_term_facts: Array.isArray(d.long_term_facts) ? d.long_term_facts : [],
        };
    }

    async saveMemory(userId: string, memory: MemoryData): Promise<void> {
        await this.col.doc(userId).set(memory);
    }

    async mergeMemory(userId: string, delta: MemoryData): Promise<MemoryData> {
        const ref = this.col.doc(userId);
        return this.db.runTransaction(async (t) => {
            const snap = await t.get(ref);
            const d = snap.exists ? (snap.data() ?? {}) : {};
            const current: MemoryData = {
                preferences: (d.preferences as Record<string, string>) ?? {},
                past_patterns: Array.isArray(d.past_patterns) ? d.past_patterns : [],
                long_term_facts: Array.isArray(d.long_term_facts) ? d.long_term_facts : [],
            };
            const merged = applyMemoryDelta(current, delta);
            t.set(ref, merged);
            return merged;
        });
    }
}