"use strict";
/**
 * src/core/synthesizer.ts — THE VOICE SOCKET.
 *
 * Twin of router.ts. The router answers "which agent next?"; the synthesizer
 * answers "given everything the agents did, what should the USER hear?" Both
 * are isolated behind an interface so the orchestrator loop never changes when
 * you swap the implementation.
 *
 *   LastMessageSynthesizer : dumb fallback (no LLM). Returns the last agent's
 *                            message — the orchestrator's old behavior.
 *   LlmSynthesizer         : fuses all agent outputs into ONE reply in DaVinci's
 *                            voice. This is what makes four agents feel like one
 *                            assistant instead of a relay race.
 *
 * Why a socket and not just an LLM call inside assemble(): same reason the
 * router is a socket. No key / offline / tests -> use the dumb one. Production
 * -> use the LLM one. The loop is identical either way.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LlmSynthesizer = exports.LastMessageSynthesizer = void 0;
/* ---------------------------------------------------------------------------
 *  DUMMY: last-message synthesizer (no-LLM fallback = old behavior).
 * ------------------------------------------------------------------------- */
class LastMessageSynthesizer {
    async synthesize({ soFar }) {
        return soFar.length ? soFar[soFar.length - 1].message : "";
    }
}
exports.LastMessageSynthesizer = LastMessageSynthesizer;
class LlmSynthesizer {
    llm;
    constructor(llm) {
        this.llm = llm;
    }
    async synthesize({ input, soFar }) {
        // Single hop: nothing to fuse. Return it verbatim — this BOTH saves an
        // LLM call AND preserves an agent's intentional formatting (e.g. the
        // planner's Week 1 / Week 2 checklist, which the user should see as-is).
        if (soFar.length <= 1)
            return soFar[0]?.message ?? "";
        const userText = input.kind === "text" ? input.text : `[scene] ${input.text ?? ""}`;
        const notes = soFar
            .map((r, i) => `${i + 1}. ${r.from} (${r.status}): ${r.message}`)
            .join("\n");
        const system = "You are DaVinci — a calm, concise personal assistant. Several internal " +
            "agents worked on the user's request; their working notes are below. " +
            "Write the SINGLE reply the user should hear, in DaVinci's voice " +
            "(2-4 sentences, warm, direct).\n\n" +
            "RULES:\n" +
            "- Answer what the USER asked. The agent notes are means, not the message.\n" +
            "- Weave the agents' work into one coherent reply. NEVER narrate the " +
            "machinery ('the researcher found', 'the planner then'). The user does " +
            "not know agents exist.\n" +
            "- If an agent's status is 'error' or 'partial', be honest about that gap. " +
            "Do NOT assert what a failed agent never actually produced.\n" +
            "- If an agent produced a formatted list/plan the user should SEE (steps, " +
            "checkmarks), preserve that block and add a short framing line instead of " +
            "rewording it into prose.";
        const user = `User asked: ${userText}\n\n` +
            `Agent notes, in order:\n${notes}\n\n` +
            `Write DaVinci's reply.`;
        try {
            const out = await this.llm.complete([
                { role: "system", content: system },
                { role: "user", content: user },
            ], { temperature: 0.4 });
            return out.trim();
        }
        catch {
            // Fusion failed -> fall back to the last agent's message so the user
            // still gets a real answer instead of an error.
            return soFar[soFar.length - 1].message;
        }
    }
}
exports.LlmSynthesizer = LlmSynthesizer;
//# sourceMappingURL=synthesizer.js.map