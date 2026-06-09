/**
 * src/store/factory.ts — ONE wiring point for all persistence.
 *
 * The rest of the app receives interfaces (UserStore, SessionStore, Store,
 * MemoryStore, PlanStore) and never knows the backing. This file makes the
 * choice:
 *
 *   - Firestore if it's configured (credentials present / ADC on GCP) and
 *     STORE_BACKEND isn't forced to "file".
 *   - File otherwise (zero-setup local dev ONLY).
 *
 * Force a backend with STORE_BACKEND=firestore | file.
 *
 * Fix 1 — two guards so a misconfigured prod deploy fails LOUD instead of
 * silently losing data on the ephemeral file backend:
 *   1. STORE_BACKEND=firestore but Firestore won't init  -> throw (was already
 *      here, kept).
 *   2. We'd otherwise resolve to the file backend while NODE_ENV=production
 *      -> throw. The file backend writes to ./data, which Cloud Run wipes on
 *      every cold start; using it in prod is always a mistake.
 */

import { Store } from "./store";
import { MemoryStore } from "./memoryStore";
import { PlanStore } from "./planStore";
import { UserStore, SessionStore } from "../auth/stores";
import { getFirestore } from "./firebase";
import {
    FileStore,
    FileUserStore,
    FileSessionStore,
    FileMemoryStore,
    FilePlanStore,
} from "./backends/file";
import {
    FirestoreUserStore,
    FirestoreSessionStore,
    FirestoreWorkingStore,
    FirestoreMemoryStore,
    FirestorePlanStore,
} from "./backends/firestore";

export interface Stores {
    users: UserStore;
    sessions: SessionStore;
    working: Store;
    memory: MemoryStore;
    plans: PlanStore;
    backend: "firestore" | "file";
}

export function buildStores(): Stores {
    const forced = process.env.STORE_BACKEND;
    const isProd = process.env.NODE_ENV === "production";
    // Forcing firestore also forces an ADC attempt, so Cloud Run works even when
    // no GCP project env var is set.
    const db = forced === "file" ? null : getFirestore(forced === "firestore");

    if (db && forced !== "file") {
        console.log("[store] Using Firestore backend.");
        return {
            users: new FirestoreUserStore(db),
            sessions: new FirestoreSessionStore(db),
            working: new FirestoreWorkingStore(db),
            memory: new FirestoreMemoryStore(db),
            plans: new FirestorePlanStore(db),
            backend: "firestore",
        };
    }

    if (forced === "firestore") {
        throw new Error(
            "[store] STORE_BACKEND=firestore but Firestore could not be initialized " +
            "(set GOOGLE_APPLICATION_CREDENTIALS, place firebase-credentials.json, " +
            "or run on GCP with Application Default Credentials)."
        );
    }

    // Refuse to silently use the ephemeral file backend in production. On Cloud
    // Run ./data is wiped on every cold start, so this would quietly lose users,
    // sessions, plans, and memory. Make the misconfiguration loud at startup.
    if (isProd) {
        throw new Error(
            "[store] Refusing to use the file backend with NODE_ENV=production. " +
            "It writes to ephemeral local disk and loses ALL data on restart. " +
            "Set STORE_BACKEND=firestore and provide Firestore credentials."
        );
    }

    console.log("[store] Using file backend (local dev). Not for multi-instance prod.");
    return {
        users: new FileUserStore(),
        sessions: new FileSessionStore(),
        working: new FileStore(),
        memory: new FileMemoryStore(),
        plans: new FilePlanStore(),
        backend: "file",
    };
}