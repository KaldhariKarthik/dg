"use strict";
/**
 * ============================================================================
 *  core/types.ts  —  THE CONTRACT ("the socket")
 * ============================================================================
 *
 *  This file is the single most important file in the project.
 *
 *  Everything else (orchestrator, researcher, planner, executor, vision agent,
 *  the model provider, the adapters) is REPLACEABLE. This file is not.
 *
 *  The rule:
 *    - Editing an agent's internal logic        -> fine, do it daily.
 *    - Editing the shapes in THIS file          -> rare, deliberate, versioned.
 *
 *  CONTRACT_VERSION 1.1 (multi-user): Context.sessionId -> Context.userId.
 *  CONTRACT_VERSION 1.2 (memory): added MemoryData + optional Context.memory,
 *  the per-user profile the orchestrator loads each turn so agents can READ
 *  what's been learned about the user (additive; existing agents unaffected).
 * ============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONTRACT_VERSION = void 0;
exports.CONTRACT_VERSION = "1.2";
//# sourceMappingURL=types.js.map