/**
 * src/store/factory.ts — ONE wiring point for all persistence.
 *
 * The rest of the app receives interfaces (UserStore, SessionStore, Store,
 * MemoryStore) and never knows the backing. This file makes the choice:
 *
 *   - Firestore if it's configured (credentials present / ADC) and
 *     STORE_BACKEND isn't forced to "file".
 *   - File otherwise (zero-setup local dev).
 *
 * Force a backend with STORE_BACKEND=firestore | file.
 */

import { Store } from "./store";
import { MemoryStore } from "./memoryStore";
import { UserStore, SessionStore } from "../auth/stores";
import { getFirestore } from "./firebase";
import {
    FileStore,
    FileUserStore,
    FileSessionStore,
    FileMemoryStore,
} from "./backends/file";
import {
    FirestoreUserStore,
    FirestoreSessionStore,
    FirestoreWorkingStore,
    FirestoreMemoryStore,
} from "./backends/firestore";

export interface Stores {
    users: UserStore;
    sessions: SessionStore;
    working: Store;
    memory: MemoryStore;
    backend: "firestore" | "file";
}

export function buildStores(): Stores {
    const forced = process.env.STORE_BACKEND;
    const db = forced === "file" ? null : getFirestore();

    if (db && forced !== "file") {
        console.log("[store] Using Firestore backend.");
        return {
            users: new FirestoreUserStore(db),
            sessions: new FirestoreSessionStore(db),
            working: new FirestoreWorkingStore(db),
            memory: new FirestoreMemoryStore(db),
            backend: "firestore",
        };
    }

    if (forced === "firestore") {
        throw new Error(
            "[store] STORE_BACKEND=firestore but Firebase is not configured " +
            "(set GOOGLE_APPLICATION_CREDENTIALS or place firebase-credentials.json)."
        );
    }

    console.log("[store] Using file backend (local dev). Not for multi-instance prod.");
    return {
        users: new FileUserStore(),
        sessions: new FileSessionStore(),
        working: new FileStore(),
        memory: new FileMemoryStore(),
        backend: "file",
    };
}