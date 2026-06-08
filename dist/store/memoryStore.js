"use strict";
/**
 * src/store/memoryStore.ts — the LONG-TERM MEMORY seam.
 *
 * Previously this file was a concrete Firestore-or-file class — the one
 * persistence path that bypassed an interface. It's now an interface, like
 * `Store`, `UserStore`, and `SessionStore`, with implementors in
 * firestoreStores.ts / fileStores.ts chosen by the factory.
 *
 * NOTE: memory is keyed by `userId` now (the authenticated Google sub), not the
 * old hardcoded "default_user". Wiring memory INTO agent reasoning is a later
 * step; this step only fixes the seam and the key.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.emptyMemory = emptyMemory;
function emptyMemory() {
    return { preferences: {}, past_patterns: [], long_term_facts: [] };
}
//# sourceMappingURL=memoryStore.js.map