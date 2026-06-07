"use strict";
/**
 * src/agents/planner.ts
 *
 * REAL agent. The one with MEMORY.
 *
 * Plans are stored as structured objects in ctx.state.plans (persisted by the
 * Store). The planner reads existing plans, decides create/update/report, and
 * writes the updated set back via stateDelta.
 *
 * Time-aware: it reasons about the goal's timeframe ("this month" -> weekly
 * milestones, "this week" -> daily, etc.) rather than emitting generic steps.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PlannerAgent = void 0;
const types_1 = require("../core/types");
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
        const now = new Date().toISOString();
        const convo = ctx.history.slice(-6).length === 0
            ? "(no prior conversation)"
            : ctx.history
                .slice(-6)
                .map((t) => `${t.role}: ${t.message}`)
                .join("\n");
        const system = "You are the Planner in a personal assistant system. You create and " +
            "track the user's goals over time, and you are TIME-AWARE.\n\n" +
            "TIMEFRAME RULES:\n" +
            "- If the user gives a timeframe, structure the plan around it with " +
            "concrete milestones:\n" +
            "  * 'this month' / '30 days' -> break into ~4 WEEKLY phases (Week 1-4), " +
            "each week a step (or a few) with a clear milestone.\n" +
            "  * 'this week' / '7 days' -> break into DAILY steps.\n" +
            "  * 'this year' -> monthly phases.\n" +
            "- Use the 'phase' field on each step to label it (e.g. 'Week 1').\n" +
            "- Make steps specific and progressive, not generic.\n\n" +
            "MEMORY RULES:\n" +
            "- You are given the user's current plans as JSON. Keep ALL existing " +
            "plans unless the user clearly abandons one. Preserve ids and createdAt.\n" +
            "- To update progress, set steps' done=true. To check in, just report.\n\n" +
            "Return STRICT JSON only, no markdown, EXACTLY:\n" +
            "{\n" +
            '  "reply": "<friendly message that ALSO lists the plan steps grouped ' +
            'by phase, using line breaks and a checkmark for done steps>",\n' +
            '  "plans": [{"id":"<slug>","goal":"<goal>","timeframe":"<e.g. 1 month>",' +
            '"steps":[{"text":"<step>","done":false,"phase":"Week 1"}],' +
            '"createdAt":"<iso>","updatedAt":"<iso>"}]\n' +
            "}\n\n" +
            "In 'reply', format the steps readably, e.g.:\n" +
            "Week 1: <step>\nWeek 2: <step>\n... Use a checkmark for done steps.";
        const user = `Recent conversation:\n${convo}\n\n` +
            `Current plans (JSON):\n${JSON.stringify(existingPlans, null, 2)}\n\n` +
            `Current time: ${now}\n` +
            `User message: ${userText}\n\n` +
            `If the message is a vague follow-up (e.g. "ok and", "continue", ` +
            `"what next"), interpret it using the conversation and existing plans ` +
            `— usually it means continue/expand the most recent plan.\n` +
            `Return the updated state as JSON.`;
        let raw;
        try {
            raw = await this.llm.complete([
                { role: "system", content: system },
                { role: "user", content: user },
            ], { temperature: 0.3 });
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
            // Replace the whole plans array. Note: we set plans directly (not merge)
            // so stale keys from older versions don't accumulate.
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