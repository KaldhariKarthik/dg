/**
 * src/store/memoryStore.ts
 *
 * Persistent long-term memory store (preferences, habits, facts).
 * Connects to Firebase Firestore if possible, falling back to local JSON file.
 */

import * as fs from "fs/promises";
import { existsSync } from "fs";
import * as path from "path";
import * as admin from "firebase-admin";

export interface MemoryData {
    preferences: Record<string, string>;
    past_patterns: string[];
    long_term_facts: string[];
}

export class MemoryStore {
    private db: admin.firestore.Firestore | null = null;
    private collection: admin.firestore.CollectionReference | null = null;
    private useFallback = false;
    private localPath = path.join(process.cwd(), "data", "local_memory_store.json");

    constructor() {
        this.initFirebase();
    }

    private initFirebase() {
        const credentialsPath = path.join(process.cwd(), "firebase-credentials.json");
        
        try {
            if (existsSync(credentialsPath)) {
                console.log(`[memory] Found Firebase credentials at: ${credentialsPath}`);
                
                // Initialize app if not already initialized
                if (admin.apps.length === 0) {
                    admin.initializeApp({
                        credential: admin.credential.cert(credentialsPath)
                    });
                }
                
                this.db = admin.firestore();
                this.collection = this.db.collection("davinci_memory");
                console.log("[memory] ✅ Firestore connected successfully.");
            } else {
                console.log("[memory] No firebase-credentials.json found. Using local store.");
                this.useFallback = true;
            }
        } catch (e) {
            console.error("[memory] Firebase init failed. Using local store fallback.", e);
            this.useFallback = true;
        }
    }

    getDefaultMemory(): MemoryData {
        return {
            preferences: {},
            past_patterns: [],
            long_term_facts: []
        };
    }

    async loadMemory(userId: string = "default_user"): Promise<MemoryData> {
        if (this.useFallback || !this.collection) {
            return this.loadLocalMemory(userId);
        }

        try {
            const docRef = this.collection.doc(userId);
            const doc = await docRef.get();
            if (doc.exists) {
                const data = doc.data() as MemoryData;
                return {
                    preferences: data.preferences || {},
                    past_patterns: data.past_patterns || [],
                    long_term_facts: data.long_term_facts || []
                };
            } else {
                const def = this.getDefaultMemory();
                await this.saveMemory(userId, def);
                return def;
            }
        } catch (err) {
            console.error("[memory] Error loading memory from Firestore:", err);
            return this.loadLocalMemory(userId);
        }
    }

    async saveMemory(userId: string, memory: MemoryData): Promise<void> {
        if (this.useFallback || !this.collection) {
            return this.saveLocalMemory(userId, memory);
        }

        try {
            const docRef = this.collection.doc(userId);
            await docRef.set(memory);
        } catch (err) {
            console.error("[memory] Error saving memory to Firestore:", err);
            await this.saveLocalMemory(userId, memory);
        }
    }

    private async loadLocalMemory(userId: string): Promise<MemoryData> {
        try {
            await fs.mkdir(path.dirname(this.localPath), { recursive: true });
            const raw = await fs.readFile(this.localPath, "utf8");
            const store = JSON.parse(raw);
            return store[userId] || this.getDefaultMemory();
        } catch {
            return this.getDefaultMemory();
        }
    }

    private async saveLocalMemory(userId: string, memory: MemoryData): Promise<void> {
        try {
            await fs.mkdir(path.dirname(this.localPath), { recursive: true });
            let store: Record<string, any> = {};
            try {
                const raw = await fs.readFile(this.localPath, "utf8");
                store = JSON.parse(raw);
            } catch {}
            store[userId] = memory;
            await fs.writeFile(this.localPath, JSON.stringify(store, null, 2), "utf8");
        } catch (err) {
            console.error("[memory] Failed to save local memory:", err);
        }
    }
}
