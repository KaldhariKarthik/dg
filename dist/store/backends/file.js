"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileMemoryStore = exports.FileSessionStore = exports.FileUserStore = exports.FileStore = void 0;
const fs_1 = require("fs");
const path = __importStar(require("path"));
const memoryStore_1 = require("../memoryStore");
const ids_1 = require("../ids");
const DEFAULT_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days
const DATA_DIR = path.join(process.cwd(), "data");
function nowIso() {
    return new Date().toISOString();
}
async function readJson(file, fallback) {
    try {
        const raw = await fs_1.promises.readFile(file, "utf8");
        const parsed = JSON.parse(raw);
        return (typeof parsed === "object" && parsed !== null ? parsed : fallback);
    }
    catch {
        return fallback;
    }
}
async function writeJson(file, data) {
    await fs_1.promises.mkdir(path.dirname(file), { recursive: true });
    await fs_1.promises.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}
/* ------------------------------ WORKING STATE -------------------------------- */
class FileStore {
    dir;
    constructor(dir = DATA_DIR) {
        this.dir = dir;
    }
    fileFor(userId) {
        // Sanitize so an id can never escape the data dir.
        const safe = userId.replace(/[^a-zA-Z0-9_-]/g, "_");
        return path.join(this.dir, `${safe}.json`);
    }
    async load(userId) {
        return readJson(this.fileFor(userId), {});
    }
    async save(userId, state) {
        await writeJson(this.fileFor(userId), state);
    }
}
exports.FileStore = FileStore;
/* ----------------------------------- USERS ----------------------------------- */
class FileUserStore {
    file = path.join(DATA_DIR, "users.json");
    async all() {
        return readJson(this.file, {});
    }
    async getUser(userId) {
        const users = await this.all();
        return users[userId] ?? null;
    }
    async upsertUser(input) {
        const users = await this.all();
        const ts = nowIso();
        const existing = users[input.id];
        const user = existing
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
    async setGoogleCredential(userId, cred) {
        const users = await this.all();
        const u = users[userId];
        if (!u)
            return;
        u.google = cred;
        await writeJson(this.file, users);
    }
    async mergeGoogleTokens(userId, tokens) {
        const users = await this.all();
        const u = users[userId];
        if (!u)
            return;
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
    async setIntegration(userId, app, cred) {
        const users = await this.all();
        const u = users[userId];
        if (!u)
            return;
        u.integrations[app] = cred;
        await writeJson(this.file, users);
    }
}
exports.FileUserStore = FileUserStore;
/* --------------------------------- SESSIONS ---------------------------------- */
class FileSessionStore {
    file = path.join(DATA_DIR, "sessions.json");
    async all() {
        return readJson(this.file, {});
    }
    async create(userId, ttlMs = DEFAULT_SESSION_TTL_MS) {
        const sessions = await this.all();
        const session = {
            id: (0, ids_1.newSessionId)(),
            userId,
            createdAt: nowIso(),
            expiresAt: new Date(Date.now() + ttlMs).toISOString(),
            lastUsedAt: nowIso(),
        };
        sessions[session.id] = session;
        await writeJson(this.file, sessions);
        return session;
    }
    async resolve(sessionId) {
        const sessions = await this.all();
        const s = sessions[sessionId];
        if (!s)
            return null;
        if (new Date(s.expiresAt).getTime() <= Date.now()) {
            delete sessions[sessionId];
            await writeJson(this.file, sessions);
            return null;
        }
        return s;
    }
    async touch(sessionId) {
        const sessions = await this.all();
        if (!sessions[sessionId])
            return;
        sessions[sessionId].lastUsedAt = nowIso();
        await writeJson(this.file, sessions);
    }
    async revoke(sessionId) {
        const sessions = await this.all();
        if (!sessions[sessionId])
            return;
        delete sessions[sessionId];
        await writeJson(this.file, sessions);
    }
    async revokeAllForUser(userId) {
        const sessions = await this.all();
        for (const id of Object.keys(sessions)) {
            if (sessions[id].userId === userId)
                delete sessions[id];
        }
        await writeJson(this.file, sessions);
    }
}
exports.FileSessionStore = FileSessionStore;
/* ---------------------------------- MEMORY ----------------------------------- */
class FileMemoryStore {
    file = path.join(DATA_DIR, "memory.json");
    async all() {
        return readJson(this.file, {});
    }
    async loadMemory(userId) {
        const store = await this.all();
        return store[userId] ?? (0, memoryStore_1.emptyMemory)();
    }
    async saveMemory(userId, memory) {
        const store = await this.all();
        store[userId] = memory;
        await writeJson(this.file, store);
    }
}
exports.FileMemoryStore = FileMemoryStore;
//# sourceMappingURL=file.js.map