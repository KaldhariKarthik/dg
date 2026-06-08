"use strict";
/**
 * src/agents/conversational.ts
 *
 * REAL agent. Handles chitchat, greetings, acknowledgements, and vague input
 * ("hmm", "ok", "thanks", "cool"). Keeps the conversation natural WITHOUT
 * dumping plans or over-explaining. Now lightly MEMORY-AWARE: it may reflect a
 * known preference in passing, but memory is context, never a script.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConversationalAgent = void 0;
const types_1 = require("../core/types");
/** Compact, optional memory context for light personalization. */
function memoryNote(ctx) {
    const m = ctx.memory;
    if (!m)
        return "";
    const has = Object.keys(m.preferences).length || m.past_patterns.length || m.long_term_facts.length;
    if (!has)
        return "";
    const prefs = Object.entries(m.preferences).map(([k, v]) => `${k}: ${v}`).join("; ") || "none";
    return ("\n- For light context only (do NOT recite, do NOT force into the reply), " +
        `you know: preferences [${prefs}]; ` +
        `patterns [${m.past_patterns.join("; ") || "none"}]; ` +
        `facts [${m.long_term_facts.join("; ") || "none"}].`);
}
class ConversationalAgent {
    llm;
    name = "conversational";
    constructor(llm) {
        this.llm = llm;
    }
    async handle(req, ctx) {
        const text = req.input.kind === "text" ? req.input.text : "(image shared)";
        const planGoals = Array.isArray(ctx.state.plans)
            ? ctx.state.plans
                .map((p) => p.goal)
                .filter(Boolean)
            : [];
        const system = "You are DaVinci, a warm, concise personal assistant. The user has sent " +
            "a casual, brief, or ambiguous message. Respond naturally in 1-2 short " +
            "sentences.\n\n" +
            "RULES:\n" +
            "- Do NOT list or dump the user's plans. Do NOT lecture.\n" +
            "- If they seem to be deciding something, you may ask ONE short, " +
            "specific question.\n" +
            "- Match their energy: a one-word message gets a light, brief reply.\n" +
            (planGoals.length
                ? `- For context only (do not recite unless asked), the user has these ` +
                    `active goals: ${planGoals.join("; ")}.`
                : "") +
            memoryNote(ctx);
        const recent = ctx.history.slice(-6).map((t) => ({
            role: t.role === "user" ? "user" : "model",
            content: t.message,
        }));
        try {
            const reply = await this.llm.complete([
                { role: "system", content: system },
                ...recent,
                { role: "user", content: text },
            ], { temperature: 0.6 });
            return {
                contractVersion: types_1.CONTRACT_VERSION,
                from: this.name,
                status: "ok",
                message: reply.trim(),
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
                contractVersion: types_1.CONTRACT_VERSION,
                from: this.name,
                status: "error",
                message: "I'm here — what would you like to do?",
                diagnostics: [`conversational LLM error: ${msg}`],
            };
        }
    }
}
exports.ConversationalAgent = ConversationalAgent;
//# sourceMappingURL=conversational.js.map