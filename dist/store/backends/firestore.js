"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.FirestoreMemoryStore = exports.FirestoreWorkingStore = exports.FirestoreSessionStore = exports.FirestoreUserStore = void 0;
const memoryStore_1 = require("../memoryStore");
const ids_1 = require("../ids");
const DEFAULT_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days
function nowIso() {
    return new Date().toISOString();
}
/* ----------------------------------- USERS ----------------------------------- */
class FirestoreUserStore {
    db;
    col;
    constructor(db) {
        this.db = db;
        this.col = db.collection("users");
    }
    async getUser(userId) {
        const snap = await this.col.doc(userId).get();
        if (!snap.exists)
            return null;
        return this.hydrate(userId, snap.data() ?? {});
    }
    async upsertUser(input) {
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
    async setGoogleCredential(userId, cred) {
        await this.col.doc(userId).set({ google: cred }, { merge: true });
    }
    async mergeGoogleTokens(userId, tokens) {
        const ref = this.col.doc(userId);
        await this.db.runTransaction(async (t) => {
            const snap = await t.get(ref);
            const prev = (snap.data()?.google ?? null);
            const merged = {
                refresh_token: tokens.refresh_token ?? prev?.refresh_token ?? null,
                access_token: tokens.access_token ?? prev?.access_token ?? null,
                expiry_date: tokens.expiry_date ?? prev?.expiry_date ?? null,
                scopes: tokens.scopes ?? prev?.scopes ?? [],
                connectedAt: prev?.connectedAt ?? nowIso(),
            };
            t.set(ref, { google: merged }, { merge: true });
        });
    }
    async setIntegration(userId, app, cred) {
        await this.col.doc(userId).set({ integrations: { [app]: cred } }, { merge: true });
    }
    hydrate(id, d) {
        return {
            id,
            email: typeof d.email === "string" ? d.email : "",
            displayName: typeof d.displayName === "string" ? d.displayName : "",
            createdAt: typeof d.createdAt === "string" ? d.createdAt : nowIso(),
            lastSeenAt: typeof d.lastSeenAt === "string" ? d.lastSeenAt : nowIso(),
            google: d.google ?? null,
            integrations: d.integrations ?? {},
        };
    }
}
exports.FirestoreUserStore = FirestoreUserStore;
/* --------------------------------- SESSIONS ---------------------------------- */
class FirestoreSessionStore {
    db;
    col;
    constructor(db) {
        this.db = db;
        this.col = db.collection("sessions");
    }
    async create(userId, ttlMs = DEFAULT_SESSION_TTL_MS) {
        const session = {
            id: (0, ids_1.newSessionId)(),
            userId,
            createdAt: nowIso(),
            expiresAt: new Date(Date.now() + ttlMs).toISOString(),
            lastUsedAt: nowIso(),
        };
        await this.col.doc(session.id).set(session);
        return session;
    }
    async resolve(sessionId) {
        const snap = await this.col.doc(sessionId).get();
        if (!snap.exists)
            return null;
        const s = snap.data();
        if (new Date(s.expiresAt).getTime() <= Date.now()) {
            this.col.doc(sessionId).delete().catch(() => { });
            return null;
        }
        return s;
    }
    async touch(sessionId) {
        await this.col.doc(sessionId).set({ lastUsedAt: nowIso() }, { merge: true });
    }
    async revoke(sessionId) {
        await this.col.doc(sessionId).delete();
    }
    async revokeAllForUser(userId) {
        const q = await this.col.where("userId", "==", userId).get();
        const batch = this.db.batch();
        q.forEach((doc) => batch.delete(doc.ref));
        await batch.commit();
    }
}
exports.FirestoreSessionStore = FirestoreSessionStore;
/* ------------------------------- WORKING STATE ------------------------------- */
class FirestoreWorkingStore {
    col;
    constructor(db) {
        this.col = db.collection("working");
    }
    async load(userId) {
        const snap = await this.col.doc(userId).get();
        return snap.exists ? (snap.data() ?? {}) : {};
    }
    async save(userId, state) {
        await this.col.doc(userId).set(state);
    }
}
exports.FirestoreWorkingStore = FirestoreWorkingStore;
/* ---------------------------------- MEMORY ----------------------------------- */
class FirestoreMemoryStore {
    col;
    constructor(db) {
        this.col = db.collection("memory");
    }
    async loadMemory(userId) {
        const snap = await this.col.doc(userId).get();
        if (!snap.exists)
            return (0, memoryStore_1.emptyMemory)();
        const d = snap.data() ?? {};
        return {
            preferences: d.preferences ?? {},
            past_patterns: Array.isArray(d.past_patterns) ? d.past_patterns : [],
            long_term_facts: Array.isArray(d.long_term_facts) ? d.long_term_facts : [],
        };
    }
    async saveMemory(userId, memory) {
        await this.col.doc(userId).set(memory);
    }
}
exports.FirestoreMemoryStore = FirestoreMemoryStore;
//# sourceMappingURL=firestore.js.map