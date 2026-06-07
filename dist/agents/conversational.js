"use strict";
/**
 * src/agents/conversational.ts
 *
 * REAL agent. Handles chitchat, greetings, acknowledgements, and vague input
 * ("hmm", "ok", "thanks", "cool"). Its job is to keep the conversation natural
 * WITHOUT dumping plans or over-explaining. If the user seems to be mulling a
 * decision, it can ask ONE short clarifying question.
 *
 * This agent exists so vague messages stop leaking into the planner. Adding it
 * was a one-file change plus one registration line — the orchestrator and
 * contract didn't move.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConversationalAgent = void 0;
const types_1 = require("../core/types");
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
                : "");
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