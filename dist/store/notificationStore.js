"use strict";
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
exports.FirestoreNotificationStore = exports.FileNotificationStore = void 0;
/**
 * src/store/notificationStore.ts — the "needs your attention" feed.
 * Proactive jobs (morning brief, Sentinel) write here; the app reads here.
 * Each notification carries a stable `key` so a job re-running can't post the
 * same alert twice (hasUnreadKey gate). File for dev, Firestore for prod.
 */
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
function sortNewest(a, b) { return b.createdAt - a.createdAt; }
/* ---------------- File backend (dev) ---------------- */
const DATA_DIR = path.join(process.cwd(), "data", "notifications");
class FileNotificationStore {
    file(userId) {
        return path.join(DATA_DIR, `${encodeURIComponent(userId)}.json`);
    }
    read(userId) {
        try {
            return JSON.parse(fs.readFileSync(this.file(userId), "utf8"));
        }
        catch {
            return [];
        }
    }
    write(userId, list) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(this.file(userId), JSON.stringify(list), "utf8");
    }
    async add(userId, n) {
        const list = this.read(userId);
        list.push(n);
        this.write(userId, list.slice(-200)); // bound growth
    }
    async list(userId, opts = {}) {
        let list = this.read(userId).sort(sortNewest);
        if (opts.unreadOnly)
            list = list.filter((n) => !n.read);
        return opts.limit ? list.slice(0, opts.limit) : list;
    }
    async hasUnreadKey(userId, key) {
        return this.read(userId).some((n) => n.key === key && !n.read);
    }
    async markRead(userId, id) {
        const list = this.read(userId).map((n) => (n.id === id ? { ...n, read: true } : n));
        this.write(userId, list);
    }
    async markAllRead(userId) {
        this.write(userId, this.read(userId).map((n) => ({ ...n, read: true })));
    }
}
exports.FileNotificationStore = FileNotificationStore;
class FirestoreNotificationStore {
    db;
    constructor(db) {
        this.db = db;
    }
    col() { return this.db.collection("notifications"); }
    async add(userId, n) {
        await this.col().doc(`${userId}__${n.id}`).set({ userId, ...n });
    }
    async list(userId, opts = {}) {
        // Query by userId only (no composite index needed); filter/sort in memory.
        const snap = await this.col().where("userId", "==", userId).get();
        let list = snap.docs.map((d) => { const { userId: _u, ...rest } = d.data(); return rest; })
            .sort(sortNewest);
        if (opts.unreadOnly)
            list = list.filter((n) => !n.read);
        return opts.limit ? list.slice(0, opts.limit) : list;
    }
    async hasUnreadKey(userId, key) {
        const snap = await this.col()
            .where("userId", "==", userId).where("key", "==", key).where("read", "==", false).limit(1).get();
        return !snap.empty;
    }
    async markRead(userId, id) {
        await this.col().doc(`${userId}__${id}`).set({ read: true }, { merge: true });
    }
    async markAllRead(userId) {
        const snap = await this.col().where("userId", "==", userId).where("read", "==", false).get();
        const batch = this.db.batch();
        snap.forEach((d) => batch.set(d.ref, { read: true }, { merge: true }));
        await batch.commit();
    }
}
exports.FirestoreNotificationStore = FirestoreNotificationStore;
//# sourceMappingURL=notificationStore.js.map