/**
 * src/store/firebase.ts — the single Firebase Admin initializer.
 *
 * Only this file calls admin.initializeApp / admin.firestore(). The Firestore
 * store implementors import the handle from here. Returns null if Firebase
 * isn't configured, which lets the factory fall back to file-backed stores in
 * LOCAL DEV (and only there — the factory now refuses files in production).
 *
 * Configure either with a credentials file (GOOGLE_APPLICATION_CREDENTIALS or
 * ./firebase-credentials.json) or with the standard ADC environment on GCP.
 *
 * Fix 1: the old code only attempted Application Default Credentials when
 * GCLOUD_PROJECT / GOOGLE_CLOUD_PROJECT happened to be set. Cloud Run does NOT
 * reliably set those, so a correct prod deploy could silently get `null` here
 * and drop to the ephemeral file backend — quietly losing all data on cold
 * start. Now: ADC is attempted whenever we look like we're on GCP (Cloud Run
 * sets K_SERVICE) OR when the caller forces it (STORE_BACKEND=firestore). Local
 * dev with no creds still returns null, so the zero-setup dev path is unchanged.
 */

import { existsSync } from "fs";
import * as path from "path";
import * as admin from "firebase-admin";

let cached: admin.firestore.Firestore | null | undefined;

/**
 * Returns a Firestore handle, or null if Firebase isn't configured.
 * @param forceAdc when true, attempt Application Default Credentials even
 *        without any GCP env hints (used when STORE_BACKEND=firestore is forced).
 */
export function getFirestore(forceAdc = false): admin.firestore.Firestore | null {
    if (cached !== undefined) return cached;

    const explicit = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const fallbackPath = path.join(process.cwd(), "firebase-credentials.json");
    const credPath = explicit && existsSync(explicit)
        ? explicit
        : existsSync(fallbackPath)
            ? fallbackPath
            : null;

    // Are we plausibly on GCP? Cloud Run always sets K_SERVICE; the project env
    // vars are set in some environments but not all. Any of these means ADC is
    // available via the metadata server.
    const onGcp = Boolean(
        process.env.K_SERVICE ||
        process.env.GCLOUD_PROJECT ||
        process.env.GOOGLE_CLOUD_PROJECT
    );

    try {
        if (admin.apps.length === 0) {
            if (credPath) {
                admin.initializeApp({ credential: admin.credential.cert(credPath) });
                console.log(`[firebase] Initialized with credentials: ${credPath}`);
            } else if (forceAdc || onGcp) {
                // Application Default Credentials (e.g. on Cloud Run). initializeApp()
                // is lazy; if ADC truly isn't available it surfaces on first query.
                admin.initializeApp();
                console.log("[firebase] Initialized with Application Default Credentials.");
            } else {
                // Local dev with no credentials of any kind: stay on the file backend.
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