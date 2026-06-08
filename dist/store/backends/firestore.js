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
exports.FirestorePlanStore = exports.FirestoreMemoryStore = exports.FirestoreWorkingStore = exports.FirestoreSessionStore = exports.FirestoreUserStore = void 0;
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
    db;
    col;
    constructor(db) {
        this.db = db;
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
    async mergeMemory(userId, delta) {
        const ref = this.col.doc(userId);
        return this.db.runTransaction(async (t) => {
            const snap = await t.get(ref);
            const d = snap.exists ? (snap.data() ?? {}) : {};
            const current = {
                preferences: d.preferences ?? {},
                past_patterns: Array.isArray(d.past_patterns) ? d.past_patterns : [],
                long_term_facts: Array.isArray(d.long_term_facts) ? d.long_term_facts : [],
            };
            const merged = (0, memoryStore_1.applyMemoryDelta)(current, delta);
            t.set(ref, merged);
            return merged;
        });
    }
}
exports.FirestoreMemoryStore = FirestoreMemoryStore;
/* ----------------------------------- PLANS ----------------------------------- */
/**
 * FirestorePlanStore — each plan is its own document under
 * plans/{userId}/items/{planId}. Because a plan lives in its own doc, upsert /
 * delete touch exactly that doc, and setStepDone runs as a single-document
 * transaction — genuinely atomic. A check-off can no longer be clobbered by the
 * orchestrator's working-state save, because plans aren't in the working bag.
 */
class FirestorePlanStore {
    db;
    constructor(db) {
        this.db = db;
    }
    items(userId) {
        return this.db.collection("plans").doc(userId).collection("items");
    }
    async listPlans(userId) {
        const snap = await this.items(userId).get();
        const plans = snap.docs.map((d) => d.data());
        plans.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
        return plans;
    }
    async getPlan(userId, planId) {
        const snap = await this.items(userId).doc(planId).get();
        return snap.exists ? snap.data() : null;
    }
    async upsertPlan(userId, plan) {
        await this.items(userId).doc(plan.id).set(plan);
        return plan;
    }
    async setStepDone(userId, planId, stepIndex, done) {
        const ref = this.items(userId).doc(planId);
        return this.db.runTransaction(async (t) => {
            const snap = await t.get(ref);
            if (!snap.exists)
                return null;
            const plan = snap.data();
            if (stepIndex < 0 || stepIndex >= plan.steps.length)
                return plan;
            plan.steps[stepIndex].done = done;
            plan.updatedAt = nowIso();
            t.set(ref, plan);
            return plan;
        });
    }
    async deletePlan(userId, planId) {
        await this.items(userId).doc(planId).delete();
    }
}
exports.FirestorePlanStore = FirestorePlanStore;
//# sourceMappingURL=firestore.js.map