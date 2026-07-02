/**
 * src/store/notificationStore.ts — the "needs your attention" feed.
 * Proactive jobs (morning brief, Sentinel) write here; the app reads here.
 * Each notification carries a stable `key` so a job re-running can't post the
 * same alert twice (hasUnreadKey gate). File for dev, Firestore for prod.
 */
import * as fs from "fs";
import * as path from "path";
import { getFirestore } from "./firebase";

export type NotificationKind = "brief" | "alert";

export interface Notification {
    id: string;
    key: string;        // dedup key, e.g. "brief:2026-06-10" or "overlap:a:b"
    kind: NotificationKind;
    title: string;
    body: string;
    createdAt: number;
    read: boolean;
}

export interface NotificationStore {
    add(userId: string, n: Notification): Promise<void>;
    list(userId: string, opts?: { unreadOnly?: boolean; limit?: number }): Promise<Notification[]>;
    hasUnreadKey(userId: string, key: string): Promise<boolean>;
    markRead(userId: string, id: string): Promise<void>;
    markAllRead(userId: string): Promise<void>;
}

function sortNewest(a: Notification, b: Notification) { return b.createdAt - a.createdAt; }

/* ---------------- File backend (dev) ---------------- */
const DATA_DIR = path.join(process.cwd(), "data", "notifications");

export class FileNotificationStore implements NotificationStore {
    private file(userId: string): string {
        return path.join(DATA_DIR, `${encodeURIComponent(userId)}.json`);
    }
    private read(userId: string): Notification[] {
        try { return JSON.parse(fs.readFileSync(this.file(userId), "utf8")) as Notification[]; }
        catch { return []; }
    }
    private write(userId: string, list: Notification[]): void {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(this.file(userId), JSON.stringify(list), "utf8");
    }
    async add(userId: string, n: Notification): Promise<void> {
        const list = this.read(userId);
        list.push(n);
        this.write(userId, list.slice(-200)); // bound growth
    }
    async list(userId: string, opts: { unreadOnly?: boolean; limit?: number } = {}): Promise<Notification[]> {
        let list = this.read(userId).sort(sortNewest);
        if (opts.unreadOnly) list = list.filter((n) => !n.read);
        return opts.limit ? list.slice(0, opts.limit) : list;
    }
    async hasUnreadKey(userId: string, key: string): Promise<boolean> {
        return this.read(userId).some((n) => n.key === key && !n.read);
    }
    async markRead(userId: string, id: string): Promise<void> {
        const list = this.read(userId).map((n) => (n.id === id ? { ...n, read: true } : n));
        this.write(userId, list);
    }
    async markAllRead(userId: string): Promise<void> {
        this.write(userId, this.read(userId).map((n) => ({ ...n, read: true })));
    }
}

/* ---------------- Firestore backend (prod) ---------------- */
type Db = NonNullable<ReturnType<typeof getFirestore>>;

export class FirestoreNotificationStore implements NotificationStore {
    constructor(private db: Db) { }
    private col() { return this.db.collection("notifications"); }

    async add(userId: string, n: Notification): Promise<void> {
        await this.col().doc(`${userId}__${n.id}`).set({ userId, ...n });
    }
    async list(userId: string, opts: { unreadOnly?: boolean; limit?: number } = {}): Promise<Notification[]> {
        // Query by userId only (no composite index needed); filter/sort in memory.
        const snap = await this.col().where("userId", "==", userId).get();
        let list = snap.docs.map((d) => { const { userId: _u, ...rest } = d.data() as any; return rest as Notification; })
            .sort(sortNewest);
        if (opts.unreadOnly) list = list.filter((n) => !n.read);
        return opts.limit ? list.slice(0, opts.limit) : list;
    }
    async hasUnreadKey(userId: string, key: string): Promise<boolean> {
        const snap = await this.col()
            .where("userId", "==", userId).where("key", "==", key).where("read", "==", false).limit(1).get();
        return !snap.empty;
    }
    async markRead(userId: string, id: string): Promise<void> {
        await this.col().doc(`${userId}__${id}`).set({ read: true }, { merge: true });
    }
    async markAllRead(userId: string): Promise<void> {
        const snap = await this.col().where("userId", "==", userId).where("read", "==", false).get();
        const batch = this.db.batch();
        snap.forEach((d) => batch.set(d.ref, { read: true }, { merge: true }));
        await batch.commit();
    }
}