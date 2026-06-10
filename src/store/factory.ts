import { Store } from "./store";
import { MemoryStore } from "./memoryStore";
import { PlanStore } from "./planStore";
import { DocumentStore, FileDocumentStore, FirestoreDocumentStore } from "./documentStore";
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
    documents: DocumentStore;
    backend: "firestore" | "file";
}

export function buildStores(): Stores {
    const forced = process.env.STORE_BACKEND;
    const isProd = process.env.NODE_ENV === "production";
    const db = forced === "file" ? null : getFirestore(forced === "firestore");

    if (db && forced !== "file") {
        console.log("[store] Using Firestore backend.");
        return {
            users: new FirestoreUserStore(db),
            sessions: new FirestoreSessionStore(db),
            working: new FirestoreWorkingStore(db),
            memory: new FirestoreMemoryStore(db),
            plans: new FirestorePlanStore(db),
            documents: new FirestoreDocumentStore(db),
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
        documents: new FileDocumentStore(),
        backend: "file",
    };
}