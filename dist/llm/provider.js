"use strict";
/**
 * src/llm/provider.ts
 *
 * The vendor-neutral model interface.
 *
 * Nothing in the system talks to Gemini directly except the one file that
 * implements this. Everything else depends on THIS interface. Swap Gemini for
 * OpenAI/Claude/local later = write one new implementor, change one wiring
 * line. The router, orchestrator, and agents never know which model is behind
 * it. That is the vendor-isolation seam.
 */
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=provider.js.map