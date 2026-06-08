"use strict";
/**
 * src/store/memoryStore.ts — the LONG-TERM MEMORY seam.
 *
 * MemoryData itself now lives in the contract (core/types.ts) because it crosses
 * module boundaries (store persists it, orchestrator loads it onto Context,
 * agents read it). It's re-exported here so backend imports stay unchanged.
 *
 * `mergeMemory` is the atomic write: instead of read-modify-write in the
 * orchestrator (which races when two turns run concurrently), the orchestrator
 * hands a DELTA of newly-learned items and the store applies it atomically.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.emptyMemory = emptyMemory;
exports.applyMemoryDelta = applyMemoryDelta;
function emptyMemory() {
    return { preferences: {}, past_patterns: [], long_term_facts: [] };
}
/**
 * Apply a delta to a base profile: preferences overwrite by key; patterns and
 * facts append with de-duplication. Pure function, shared by every backend so
 * the merge semantics are defined in exactly one place.
 */
function applyMemoryDelta(base, delta) {
    const preferences = { ...base.preferences, ...delta.preferences };
    const past_patterns = [...base.past_patterns];
    for (const p of delta.past_patterns) {
        if (p && !past_patterns.includes(p))
            past_patterns.push(p);
    }
    const long_term_facts = [...base.long_term_facts];
    for (const f of delta.long_term_facts) {
        if (f && !long_term_facts.includes(f))
            long_term_facts.push(f);
    }
    return { preferences, past_patterns, long_term_facts };
}
//# sourceMappingURL=memoryStore.js.map