"use strict";
/**
 * ============================================================================
 *  core/types.ts  —  THE CONTRACT ("the socket")
 * ============================================================================
 *
 *  This file is the single most important file in the project.
 *
 *  Everything else (orchestrator, researcher, planner, executor, future vision
 *  agent, the model provider, the adapters) is REPLACEABLE. This file is not.
 *
 *  The rule:
 *    - Editing an agent's internal logic        -> fine, do it daily.
 *    - Editing the shapes in THIS file          -> rare, deliberate, versioned.
 *
 *  Why: as long as every agent speaks these exact shapes, you can rewrite,
 *  swap, or add agents without anything else noticing. That is the
 *  "change 1 thing != break the system" property. It lives here.
 *
 *  When you genuinely must change a shape, bump CONTRACT_VERSION and treat it
 *  as a migration, not a casual edit.
 * ============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONTRACT_VERSION = void 0;
exports.CONTRACT_VERSION = "1.0";
//# sourceMappingURL=types.js.map