/**
 * src/store/store.ts
 *
 * Swappable persistence for DURABLE agent state (e.g. the planner's progress
 * across requests). NOT conversation history — that comes from the website per
 * request. This is server-owned state keyed by sessionId.
 *
 * The orchestrator/agents depend on THIS interface, never on a concrete store.
 * Today it's backed by a JSON file (fileStore.ts). Swap for Redis/Postgres
 * later = one new implementor, one wiring line. Nothing upstream changes.
 */

export interface Store {
    /** Load a session's state bag. Returns {} if the session is new. */
    load(sessionId: string): Promise<Record<string, unknown>>;
    /** Persist a session's state bag (full replace). */
    save(sessionId: string, state: Record<string, unknown>): Promise<void>;
}