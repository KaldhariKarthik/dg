"use strict";
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
exports.getFirestore = getFirestore;
const fs_1 = require("fs");
const path = __importStar(require("path"));
const admin = __importStar(require("firebase-admin"));
let cached;
/**
 * Returns a Firestore handle, or null if Firebase isn't configured.
 * @param forceAdc when true, attempt Application Default Credentials even
 *        without any GCP env hints (used when STORE_BACKEND=firestore is forced).
 */
function getFirestore(forceAdc = false) {
    if (cached !== undefined)
        return cached;
    const explicit = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const fallbackPath = path.join(process.cwd(), "firebase-credentials.json");
    const credPath = explicit && (0, fs_1.existsSync)(explicit)
        ? explicit
        : (0, fs_1.existsSync)(fallbackPath)
            ? fallbackPath
            : null;
    // Are we plausibly on GCP? Cloud Run always sets K_SERVICE; the project env
    // vars are set in some environments but not all. Any of these means ADC is
    // available via the metadata server.
    const onGcp = Boolean(process.env.K_SERVICE ||
        process.env.GCLOUD_PROJECT ||
        process.env.GOOGLE_CLOUD_PROJECT);
    try {
        if (admin.apps.length === 0) {
            if (credPath) {
                admin.initializeApp({ credential: admin.credential.cert(credPath) });
                console.log(`[firebase] Initialized with credentials: ${credPath}`);
            }
            else if (forceAdc || onGcp) {
                // Application Default Credentials (e.g. on Cloud Run). initializeApp()
                // is lazy; if ADC truly isn't available it surfaces on first query.
                admin.initializeApp();
                console.log("[firebase] Initialized with Application Default Credentials.");
            }
            else {
                // Local dev with no credentials of any kind: stay on the file backend.
                cached = null;
                return cached;
            }
        }
        cached = admin.firestore();
        return cached;
    }
    catch (e) {
        console.error("[firebase] Initialization failed; will use file stores.", e);
        cached = null;
        return cached;
    }
}
//# sourceMappingURL=firebase.js.map