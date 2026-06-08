"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VISION_SCHEMA_VERSION = exports.CONTRACT_VERSION = void 0;
exports.CONTRACT_VERSION = "1.2";
/* ----------------------------------------------------------------------------
 *  VISION PERCEPTION SCHEMA (v1.0) — the single source of truth.
 *
 *  The perception edge (the browser client + the /api/vision model) emits a
 *  structured observation; the vision agent consumes it and returns a directive.
 *  These shapes used to be written down in four places (the model's system
 *  prompt, the /api/vision response literal, the browser client, and the vision
 *  agent) — exactly how schemas drift. They live HERE now so the client
 *  (compiled by esbuild) and the server import ONE definition.
 *
 *  ADDITIVE: SceneInput.scene stays `unknown` at the agent boundary (we can't
 *  force a model's output to be typed), so the agent CONTRACT is unchanged and
 *  CONTRACT_VERSION stays 1.2. These types describe the vision envelope, which
 *  carries its own `schema_version` ("1.0").
 * ------------------------------------------------------------------------- */
exports.VISION_SCHEMA_VERSION = "1.0";
//# sourceMappingURL=types.js.map