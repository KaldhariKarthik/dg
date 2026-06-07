"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=store.js.map