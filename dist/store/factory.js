"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildStores = buildStores;
const firebase_1 = require("./firebase");
const file_1 = require("./backends/file");
const firestore_1 = require("./backends/firestore");
function buildStores() {
    const forced = process.env.STORE_BACKEND;
    const db = forced === "file" ? null : (0, firebase_1.getFirestore)();
    if (db && forced !== "file") {
        console.log("[store] Using Firestore backend.");
        return {
            users: new firestore_1.FirestoreUserStore(db),
            sessions: new firestore_1.FirestoreSessionStore(db),
            working: new firestore_1.FirestoreWorkingStore(db),
            memory: new firestore_1.FirestoreMemoryStore(db),
            backend: "firestore",
        };
    }
    if (forced === "firestore") {
        throw new Error("[store] STORE_BACKEND=firestore but Firebase is not configured " +
            "(set GOOGLE_APPLICATION_CREDENTIALS or place firebase-credentials.json).");
    }
    console.log("[store] Using file backend (local dev). Not for multi-instance prod.");
    return {
        users: new file_1.FileUserStore(),
        sessions: new file_1.FileSessionStore(),
        working: new file_1.FileStore(),
        memory: new file_1.FileMemoryStore(),
        backend: "file",
    };
}
//# sourceMappingURL=factory.js.map