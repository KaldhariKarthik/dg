"use strict";
/**
 * src/agents/planner.ts
 *
 * REAL agent. DATE-AWARE, and now MEMORY-AWARE.
 *
 * Plans are structured objects in ctx.state.plans (persisted by the Store).
 * The planner reads existing plans + recent conversation + the user's long-term
 * memory, decides create/update/report, and writes the updated set back via
 * stateDelta.
 *
 * Memory use (v1.2): the planner may bias plans toward known preferences/
 * patterns (e.g. a habit of trimming plans down -> lean simpler) — but memory is
 * CONTEXT, never a command. An explicit request ("plan a 2-week trip") always
 * wins over a remembered "prefers short trips".
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PlannerAgent = void 0;
const types_1 = require("../core/types");
/** Format the user's memory as optional prompt context, with a guardrail. */
function memoryNote(ctx) {
    const m = ctx.memory;
    if (!m)
        return "";
    const has = Object.keys(m.preferences).length || m.past_patterns.length || m.long_term_facts.length;
    if (!has)
        return "";
    const prefs = Object.entries(m.preferences).map(([k, v]) => `${k}: ${v}`).join("; ") || "none";
    return (`\n\nWhat you've learned about this user (CONTEXT, not commands — use only ` +
        `when relevant, and NEVER override an explicit current request):\n` +
        `- Preferences: ${prefs}\n` +
        `- Patterns: ${m.past_patterns.join("; ") || "none"}\n` +
        `- Facts: ${m.long_term_facts.join("; ") || "none"}`);
}
class PlannerAgent {
    llm;
    name = "planner";
    constructor(llm) {
        this.llm = llm;
    }
    async handle(req, ctx) {
        const userText = req.input.kind === "text"
            ? req.input.text
            : `Based on this scene: ${req.input.text ?? "(image)"}`;
        const existingPlans = this.readPlans(ctx);
        const now = new Date();
        const nowIso = now.toISOString();
        const human = now.toLocaleDateString("en-US", {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
        });
        const convo = ctx.history.slice(-6).length === 0
            ? "(no prior conversation)"
            : ctx.history.slice(-6).map((t) => `${t.role}: ${t.message}`).join("\n");
        const system = "You are the Planner in the DaVinci assistant. You create and track the " +
            "user's goals over time. You know today's date and reason about real " +
            "timeframes.\n\n" +
            "TIMEFRAME — be sensible, NOT rigid:\n" +
            "- Compute the target end date from today's date and the user's " +
            "timeframe.\n" +
            "- Break the plan into whatever chunks NATURALLY fit that duration. Do " +
            "NOT force weeks. Use your judgment and label each phase honestly.\n" +
            "- Steps must be specific and progressive, sized to the real timeframe.\n\n" +
            "RESPONSE SCOPE:\n" +
            "- Reply about the plan the user is actually discussing. Do NOT recite " +
            "every plan. You MAY briefly mention another plan only if it's genuinely " +
            "relevant (e.g. a scheduling conflict).\n\n" +
            "MEMORY:\n" +
            "- You get all current plans as JSON. Keep them all unless the user " +
            "abandons one. Preserve ids/createdAt. Mark steps done to track progress.\n\n" +
            "Return STRICT JSON only, no markdown, EXACTLY:\n" +
            "{\n" +
            '  "reply": "<friendly message that lists THIS plan\'s steps readably, ' +
            'grouped by your chosen phase labels, with a checkmark for done steps>",\n' +
            '  "plans": [{"id":"<slug>","goal":"<goal>","timeframe":"<e.g. 23 days>",' +
            '"targetDate":"<iso date or empty>","steps":[{"text":"<step>",' +
            '"done":false,"phase":"<your label>"}],"createdAt":"<iso>",' +
            '"updatedAt":"<iso>"}]\n' +
            "}";
        const user = `Today is ${human} (${nowIso}).\n\n` +
            `Recent conversation:\n${convo}\n\n` +
            `Current plans (JSON):\n${JSON.stringify(existingPlans, null, 2)}` +
            memoryNote(ctx) +
            `\n\nUser message: ${userText}\n\n` +
            `If the message is a vague follow-up ("ok and", "continue", "what ` +
            `next"), interpret it using the conversation + plans — usually it means ` +
            `continue/expand the most recently discussed plan.\n` +
            `Return the updated state as JSON.`;
        let raw;
        try {
            raw = await this.llm.complete([
                { role: "system", content: system },
                { role: "user", content: user },
            ], { temperature: 0.4 });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
                contractVersion: types_1.CONTRACT_VERSION,
                from: this.name,
                status: "error",
                message: "I couldn't update your plans right now.",
                diagnostics: [`planner LLM error: ${msg}`],
            };
        }
        const result = this.parse(raw);
        if (!result) {
            return {
                contractVersion: types_1.CONTRACT_VERSION,
                from: this.name,
                status: "partial",
                message: "I understood your request but had trouble structuring the plan. " +
                    "Could you rephrase the goal?",
                diagnostics: ["planner: failed to parse LLM JSON"],
            };
        }
        return {
            contractVersion: types_1.CONTRACT_VERSION,
            from: this.name,
            status: "ok",
            message: result.reply,
            data: { planCount: result.plans.length },
            stateDelta: { plans: result.plans },
        };
    }
    readPlans(ctx) {
        const raw = ctx.state.plans;
        return Array.isArray(raw) ? raw : [];
    }
    parse(raw) {
        const cleaned = raw.replace(/```json|```/g, "").trim();
        const start = cleaned.indexOf("{");
        const end = cleaned.lastIndexOf("}");
        if (start === -1 || end === -1 || end < start)
            return null;
        let obj;
        try {
            obj = JSON.parse(cleaned.slice(start, end + 1));
        }
        catch {
            return null;
        }
        if (typeof obj !== "object" || obj === null)
            return null;
        const o = obj;
        if (typeof o.reply !== "string" || !Array.isArray(o.plans))
            return null;
        return { reply: o.reply, plans: o.plans };
    }
}
exports.PlannerAgent = PlannerAgent;
//# sourceMappingURL=planner.js.map