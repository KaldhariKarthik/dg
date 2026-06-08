"use strict";
/**
 * src/adapters/adapter.ts — THE ADAPTER SEAM.
 *
 * Same idea as llm/provider.ts, but for ACTIONS instead of text generation.
 *
 * The executor performs real-world side effects (send an email, create a
 * calendar event, play a song). Each of those lives behind a small, focused
 * adapter interface. The executor depends on these interfaces — never on
 * googleapis or the Spotify SDK directly. Swap Gmail's implementation, add
 * Calendar, add Spotify = write one new implementor. The executor barely
 * changes; the contract (core/types.ts) never changes.
 *
 * Every adapter is "per user": it is constructed with a way to get that user's
 * credentials (see google-auth.ts). Multi-user falls out for free because the
 * sessionId selects whose tokens are used.
 */
Object.defineProperty(exports, "__esModule", { value: true });
/* ----------------------------------------------------------------------------
 *  Future adapters (Spotify, etc.) slot in here with the same shape.
 * ------------------------------------------------------------------------- */ 
//# sourceMappingURL=adapter.js.map