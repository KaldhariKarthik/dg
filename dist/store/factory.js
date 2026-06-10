"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildStores = buildStores;
const documentStore_1 = require("./documentStore");
const firebase_1 = require("./firebase");
const notificationStore_1 = require("./notificationStore");
const file_1 = require("./backends/file");
const firestore_1 = require("./backends/firestore");
function buildStores() {
    const forced = process.env.STORE_BACKEND;
    const isProd = process.env.NODE_ENV === "production";
    const db = forced === "file" ? null : (0, firebase_1.getFirestore)(forced === "firestore");
    if (db && forced !== "file") {
        console.log("[store] Using Firestore backend.");
        return {
            users: new firestore_1.FirestoreUserStore(db),
            sessions: new firestore_1.FirestoreSessionStore(db),
            working: new firestore_1.FirestoreWorkingStore(db),
            memory: new firestore_1.FirestoreMemoryStore(db),
            plans: new firestore_1.FirestorePlanStore(db),
            documents: new documentStore_1.FirestoreDocumentStore(db),
            notifications: new notificationStore_1.FirestoreNotificationStore(db),
            backend: "firestore",
        };
    }
    if (forced === "firestore") {
        throw new Error("[store] STORE_BACKEND=firestore but Firestore could not be initialized " +
            "(set GOOGLE_APPLICATION_CREDENTIALS, place firebase-credentials.json, " +
            "or run on GCP with Application Default Credentials).");
    }
    if (isProd) {
        throw new Error("[store] Refusing to use the file backend with NODE_ENV=production. " +
            "It writes to ephemeral local disk and loses ALL data on restart. " +
            "Set STORE_BACKEND=firestore and provide Firestore credentials.");
    }
    console.log("[store] Using file backend (local dev). Not for multi-instance prod.");
    return {
        users: new file_1.FileUserStore(),
        sessions: new file_1.FileSessionStore(),
        working: new file_1.FileStore(),
        memory: new file_1.FileMemoryStore(),
        plans: new file_1.FilePlanStore(),
        documents: new documentStore_1.FileDocumentStore(),
        notifications: new notificationStore_1.FileNotificationStore(),
        backend: "file",
    };
}
//# sourceMappingURL=factory.js.map