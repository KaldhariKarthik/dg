"use strict";
/**
 * src/core/router.ts — THE BRAIN SOCKET.
 *
 * The orchestrator asks the Router one question each step: which agent next,
 * or are we done? The decision is isolated here so the brain can be swapped
 * (KeywordRouter <-> LlmRouter) without touching the loop.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LlmRouter = exports.KeywordRouter = void 0;
/* ---------------------------------------------------------------------------
 *  DUMMY: keyword router (no-API-key fallback).
 * ------------------------------------------------------------------------- */
class KeywordRouter {
    async decide(rc) {
        if (rc.soFar.length > 0) {
            return { action: "finish", reason: "dummy router: one hop complete" };
        }
        const text = rc.input.kind === "text"
            ? rc.input.text.toLowerCase()
            : (rc.input.text ?? "").toLowerCase();
        let agent = "researcher";
        if (/\b(plan|goal|agenda|track)\b/.test(text))
            agent = "planner";
        else if (/\b(send|email|schedule|calendar|note|remind)\b/.test(text))
            agent = "executor";
        if (!rc.available.includes(agent))
            agent = "researcher";
        return { action: "call", agent };
    }
}
exports.KeywordRouter = KeywordRouter;
class LlmRouter {
    llm;
    constructor(llm) {
        this.llm = llm;
    }
    async decide(rc) {
        const userText = rc.input.kind === "text"
            ? rc.input.text
            : `[vision scene] ${rc.input.text ?? ""}`;
        // Recent conversation, so ambiguous follow-ups ("ok and", "what about it")
        // can be routed using what was just discussed.
        const convo = rc.ctx.history.slice(-6).length === 0
            ? "(no prior conversation)"
            : rc.ctx.history
                .slice(-6)
                .map((t) => `${t.role}: ${t.message}`)
                .join("\n");
        // Existing plans, so "continue"/"next" can route to the planner.
        const plans = Array.isArray(rc.ctx.state.plans)
            ? rc.ctx.state.plans
                .map((p) => `- ${p.goal ?? "(untitled plan)"}`)
                .join("\n")
            : "(none)";
        const alreadyCalled = rc.soFar.map((r) => r.from);
        const stepsTaken = rc.soFar.length === 0
            ? "(no agent has acted yet this turn)"
            : rc.soFar
                .map((r, i) => `${i + 1}. ${r.from} responded: ${r.message}`)
                .join("\n");
        const system = "You are the orchestrator of the DaVinci assistant. Each step, pick the " +
            "SINGLE best agent for the user's message, or finish.\n\n" +
            "Agents:\n" +
            "- researcher: factual questions, explanations, lookups (capitals, how " +
            "things work, distances, dates, definitions).\n" +
            "- planner: ONLY when the user wants to create, change, check, or " +
            "continue a goal/plan. Building plans, marking progress, asking 'what's " +
            "my plan'.\n" +
            "- executor: performing real actions (send email, add calendar event, " +
            "make a note).\n" +
            "- conversational: greetings, thanks, acknowledgements, and vague/" +
            "ambiguous messages ('hmm', 'ok', 'cool', 'idk'). Light chitchat.\n\n" +
            "ROUTING JUDGMENT:\n" +
            "1. A factual question is researcher — even if the user has active " +
            "plans. Having plans does NOT make every message about planning.\n" +
            "2. Vague/short/social messages ('hmm', 'thanks') go to conversational, " +
            "NOT planner. Do not trigger plan updates from filler.\n" +
            "3. Only route to planner if the message is clearly about a goal/plan, " +
            "OR a vague follow-up DIRECTLY after planning talk (e.g. 'ok and?' right " +
            "after building a plan).\n" +
            "4. If an agent already acted this turn, do NOT call it again; finish.\n" +
            "5. You MUST call at least one agent before finishing. Never finish on " +
            "step one. When truly unsure, use conversational.\n\n" +
            "Reply with STRICT JSON only — no prose, no markdown:\n" +
            '{"action":"call","agent":"researcher|planner|executor|conversational"}\n' +
            '{"action":"finish","reason":"<short>"}';
        const user = `User message: ${userText}\n\n` +
            `Recent conversation:\n${convo}\n\n` +
            `User's existing plans:\n${plans}\n\n` +
            `Agents available: ${rc.available.join(", ")}\n` +
            `Agents already called this turn: ${alreadyCalled.length ? alreadyCalled.join(", ") : "none"}\n` +
            `Steps taken so far:\n${stepsTaken}\n\n` +
            `Next step? JSON only.`;
        let raw;
        try {
            raw = await this.llm.complete([
                { role: "system", content: system },
                { role: "user", content: user },
            ], { temperature: 0 });
        }
        catch (err) {
            console.error("[router] LLM call failed, using fallback:", err);
            return this.fallback(rc);
        }
        const parsed = this.parse(raw, rc);
        return parsed ?? this.fallback(rc);
    }
    parse(raw, rc) {
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
        if (o.action === "finish") {
            return {
                action: "finish",
                reason: typeof o.reason === "string" ? o.reason : "model finished",
            };
        }
        if (o.action === "call") {
            const agent = o.agent;
            if (typeof agent === "string" && rc.available.includes(agent)) {
                // Guard: if the model tries to re-call an agent that already acted,
                // treat it as "finish" instead. Belt-and-suspenders against loops.
                if (rc.soFar.some((r) => r.from === agent)) {
                    return { action: "finish", reason: `${agent} already responded` };
                }
                return { action: "call", agent: agent };
            }
        }
        return null;
    }
    fallback(rc) {
        if (rc.soFar.length > 0) {
            return { action: "finish", reason: "fallback: work already done" };
        }
        const agent = rc.available.includes("researcher")
            ? "researcher"
            : rc.available[0];
        return { action: "call", agent };
    }
}
exports.LlmRouter = LlmRouter;
//# sourceMappingURL=router.js.map