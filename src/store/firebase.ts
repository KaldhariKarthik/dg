/**
 * src/store/firebase.ts — the single Firebase Admin initializer.
 *
 * Only this file calls admin.initializeApp / admin.firestore(). The Firestore
 * store implementors import the handle from here. Returns null if Firebase
 * isn't configured, which lets the factory fall back to file-backed stores.
 *
 * Configure either with a credentials file (GOOGLE_APPLICATION_CREDENTIALS or
 * ./firebase-credentials.json) or with the standard ADC environment on GCP.
 */

import { existsSync } from "fs";
import * as path from "path";
import * as admin from "firebase-admin";

let cached: admin.firestore.Firestore | null | undefined;

/** Returns a Firestore handle, or null if Firebase isn't configured. */
export function getFirestore(): admin.firestore.Firestore | null {
    if (cached !== undefined) return cached;

    const explicit = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const fallbackPath = path.join(process.cwd(), "firebase-credentials.json");
    const credPath = explicit && existsSync(explicit)
        ? explicit
        : existsSync(fallbackPath)
            ? fallbackPath
            : null;

    try {
        if (admin.apps.length === 0) {
            if (credPath) {
                admin.initializeApp({ credential: admin.credential.cert(credPath) });
                console.log(`[firebase] Initialized with credentials: ${credPath}`);
            } else if (process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT) {
                // Application Default Credentials (e.g. on Cloud Run).
                admin.initializeApp();
                console.log("[firebase] Initialized with Application Default Credentials.");
            } else {
                cached = null;
                return cached;
            }
        }
        cached = admin.firestore();
        return cached;
    } catch (e) {
        console.error("[firebase] Initialization failed; will use file stores.", e);
        cached = null;
        return cached;
    }
}