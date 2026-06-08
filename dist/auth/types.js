"use strict";
/**
 * src/auth/types.ts — the IDENTITY contract.
 *
 * These shapes are the multi-user foundation. Everything in the system is
 * ultimately keyed by `User.id`, which is the Google `sub` claim — a stable,
 * opaque, per-account id that never changes (unlike email).
 *
 * Two token tiers (see spec §2):
 *   - `google`        : the user's Google credential. Doubles as BOTH the login
 *                       identity AND the Gmail/Calendar capability, so it's a
 *                       first-class field.
 *   - `integrations`  : every NON-Google connected app (Spotify, Notion, ...)
 *                       slots in here later with zero changes to identity.
 */
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=types.js.map