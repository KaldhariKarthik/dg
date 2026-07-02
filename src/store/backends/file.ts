/**
 * src/store/backends/file.ts — ALL file-backed store implementors (LOCAL DEV).
 *
 * One place for every file backing:
 *   - FileStore        : working-state bag (the planner/vision scratch), one
 *                        JSON file per user under ./data/<userId>.json
 *   - FileUserStore    : ./data/users.json
 *   - FileSessionStore : ./data/sessions.json
 *   - FileMemoryStore  : ./data/memory.json
 *
 * Single-process, so plain read-modify-write is fine here. The multi-instance /
 * concurrency reasons to avoid files apply to PROD — where the factory picks the
 * Firestore backend instead.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { Store } from "../store";
import { MemoryStore, MemoryData, emptyMemory, applyMemoryDelta } from "../memoryStore";
import { Plan, PlanStore } from "../planStore";
import { newSessionId } from "../ids";
import { UserStore, SessionStore, UpsertUserInput } from "../../auth/stores";
import { User, Session, GoogleCredential, IntegrationCredential } from "../../auth/types";

const DEFAULT_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days
const DATA_DIR = path.join(process.cwd(), "data");

function nowIso(): string {
    return new Date().toISOString();
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
    try {
        const raw = await fs.readFile(file, "utf8");
        const parsed = JSON.parse(raw);
        return (typeof parsed === "object" && parsed !== null ? parsed : fallback) as T;
    } catch {
        return fallback;
    }
}

async function writeJson(file: string, data: unknown): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

/* ------------------------------ WORKING STATE -------------------------------- */

export class FileStore implements Store {
    constructor(private dir: string = DATA_DIR) { }

    private fileFor(userId: string): string {
        // Sanitize so an id can never escape the data dir.
        const safe = userId.replace(/[^a-zA-Z0-9_-]/g, "_");
        return path.join(this.dir, `${safe}.json`);
    }

    async load(userId: string): Promise<Record<string, unknown>> {
        return readJson<Record<string, unknown>>(this.fileFor(userId), {});
    }

    async save(userId: string, state: Record<string, unknown>): Promise<void> {
        await writeJson(this.fileFor(userId), state);
    }
}

/* ----------------------------------- USERS ----------------------------------- */

export class FileUserStore implements UserStore {
    private file = path.join(DATA_DIR, "users.json");

    private async all(): Promise<Record<string, User>> {
        return readJson<Record<string, User>>(this.file, {});
    }

    async getUser(userId: string): Promise<User | null> {
        const users = await this.all();
        return users[userId] ?? null;
    }

    async upsertUser(input: UpsertUserInput): Promise<User> {
        const users = await this.all();
        const ts = nowIso();
        const existing = users[input.id];
        const user: User = existing
            ? { ...existing, email: input.email, displayName: input.displayName, lastSeenAt: ts }
            : {
                id: input.id,
                email: input.email,
                displayName: input.displayName,
                createdAt: ts,
                lastSeenAt: ts,
                google: null,
                integrations: {},
            };
        users[input.id] = user;
        await writeJson(this.file, users);
        return user;
    }

    async setGoogleCredential(userId: string, cred: GoogleCredential): Promise<void> {
        const users = await this.all();
        const u = users[userId];
        if (!u) return;
        u.google = cred;
        await writeJson(this.file, users);
    }

    async mergeGoogleTokens(userId: string, tokens: Partial<GoogleCredential>): Promise<void> {
        const users = await this.all();
        const u = users[userId];
        if (!u) return;
        const prev = u.google;
        u.google = {
            refresh_token: tokens.refresh_token ?? prev?.refresh_token ?? null,
            access_token: tokens.access_token ?? prev?.access_token ?? null,
            expiry_date: tokens.expiry_date ?? prev?.expiry_date ?? null,
            scopes: tokens.scopes ?? prev?.scopes ?? [],
            connectedAt: prev?.connectedAt ?? nowIso(),
        };
        await writeJson(this.file, users);
    }

    async setIntegration(userId: string, app: string, cred: IntegrationCredential): Promise<void> {
        const users = await this.all();
        const u = users[userId];
        if (!u) return;
        u.integrations[app] = cred;
        await writeJson(this.file, users);
    }
}

/* --------------------------------- SESSIONS ---------------------------------- */

export class FileSessionStore implements SessionStore {
    private file = path.join(DATA_DIR, "sessions.json");

    private async all(): Promise<Record<string, Session>> {
        return readJson<Record<string, Session>>(this.file, {});
    }

    async create(userId: string, ttlMs = DEFAULT_SESSION_TTL_MS): Promise<Session> {
        const sessions = await this.all();
        const session: Session = {
            id: newSessionId(),
            userId,
            createdAt: nowIso(),
            expiresAt: new Date(Date.now() + ttlMs).toISOString(),
            lastUsedAt: nowIso(),
        };
        sessions[session.id] = session;
        await writeJson(this.file, sessions);
        return session;
    }

    async resolve(sessionId: string): Promise<Session | null> {
        const sessions = await this.all();
        const s = sessions[sessionId];
        if (!s) return null;
        if (new Date(s.expiresAt).getTime() <= Date.now()) {
            delete sessions[sessionId];
            await writeJson(this.file, sessions);
            return null;
        }
        return s;
    }

    async touch(sessionId: string): Promise<void> {
        const sessions = await this.all();
        if (!sessions[sessionId]) return;
        sessions[sessionId].lastUsedAt = nowIso();
        await writeJson(this.file, sessions);
    }

    async revoke(sessionId: string): Promise<void> {
        const sessions = await this.all();
        if (!sessions[sessionId]) return;
        delete sessions[sessionId];
        await writeJson(this.file, sessions);
    }

    async revokeAllForUser(userId: string): Promise<void> {
        const sessions = await this.all();
        for (const id of Object.keys(sessions)) {
            if (sessions[id].userId === userId) delete sessions[id];
        }
        await writeJson(this.file, sessions);
    }
}

/* ---------------------------------- MEMORY ----------------------------------- */

export class FileMemoryStore implements MemoryStore {
    private file = path.join(DATA_DIR, "memory.json");

    private async all(): Promise<Record<string, MemoryData>> {
        return readJson<Record<string, MemoryData>>(this.file, {});
    }

    async loadMemory(userId: string): Promise<MemoryData> {
        const store = await this.all();
        return store[userId] ?? emptyMemory();
    }

    async saveMemory(userId: string, memory: MemoryData): Promise<void> {
        const store = await this.all();
        store[userId] = memory;
        await writeJson(this.file, store);
    }

    async mergeMemory(userId: string, delta: MemoryData): Promise<MemoryData> {
        const store = await this.all();
        const merged = applyMemoryDelta(store[userId] ?? emptyMemory(), delta);
        store[userId] = merged;
        await writeJson(this.file, store);
        return merged;
    }
}

/* ----------------------------------- PLANS ----------------------------------- */

/**
 * FilePlanStore — plans live in ./data/plans.json as { [userId]: Plan[] }.
 * Single-process dev backend: read-modify-write of one file. Serially safe for a
 * single user; the per-document atomicity guarantee is the Firestore backend's.
 */
export class FilePlanStore implements PlanStore {
    private file = path.join(DATA_DIR, "plans.json");

    private async all(): Promise<Record<string, Plan[]>> {
        return readJson<Record<string, Plan[]>>(this.file, {});
    }

    async listPlans(userId: string): Promise<Plan[]> {
        const all = await this.all();
        const list = all[userId] ?? [];
        return [...list].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    }

    async getPlan(userId: string, planId: string): Promise<Plan | null> {
        const all = await this.all();
        return (all[userId] ?? []).find((p) => p.id === planId) ?? null;
    }

    async upsertPlan(userId: string, plan: Plan): Promise<Plan> {
        const all = await this.all();
        const list = all[userId] ?? [];
        const idx = list.findIndex((p) => p.id === plan.id);
        if (idx === -1) list.push(plan);
        else list[idx] = plan;
        all[userId] = list;
        await writeJson(this.file, all);
        return plan;
    }

    async setStepDone(
        userId: string,
        planId: string,
        stepIndex: number,
        done: boolean
    ): Promise<Plan | null> {
        const all = await this.all();
        const list = all[userId] ?? [];
        const plan = list.find((p) => p.id === planId);
        if (!plan) return null;
        if (stepIndex < 0 || stepIndex >= plan.steps.length) return plan;
        plan.steps[stepIndex].done = done;
        plan.updatedAt = nowIso();
        all[userId] = list;
        await writeJson(this.file, all);
        return plan;
    }

    async deletePlan(userId: string, planId: string): Promise<void> {
        const all = await this.all();
        const list = all[userId] ?? [];
        all[userId] = list.filter((p) => p.id !== planId);
        await writeJson(this.file, all);
    }
}