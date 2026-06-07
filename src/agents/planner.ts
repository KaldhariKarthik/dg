/**
 * src/agents/planner.ts
 *
 * REAL agent. The one with MEMORY, now DATE-AWARE and not rigid.
 *
 * Plans are structured objects in ctx.state.plans (persisted by the Store).
 * The planner reads existing plans + recent conversation, decides
 * create/update/report, and writes the updated set back via stateDelta.
 *
 * Design fixes from earlier:
 *  - It knows TODAY'S DATE, so "this month" / "23 days" map to real dates.
 *  - It chooses the NATURAL breakdown for the timeframe (no forced weeks).
 *  - It replies about the RELEVANT plan only (mentions others briefly if it
 *    actually matters), instead of dumping every plan every time.
 */

import {
    Agent,
    AgentRequest,
    AgentResponse,
    Context,
    CONTRACT_VERSION,
} from "../core/types";
import { LLMProvider } from "../llm/provider";

interface PlanStep {
    text: string;
    done: boolean;
    phase?: string; // natural label the planner chooses, e.g. "Days 1-5"
}

interface Plan {
    id: string;
    goal: string;
    timeframe?: string;
    targetDate?: string; // ISO date the goal should be done by, if known
    steps: PlanStep[];
    createdAt: string;
    updatedAt: string;
}

interface PlannerLlmResult {
    reply: string;
    plans: Plan[];
}

export class PlannerAgent implements Agent {
    readonly name = "planner" as const;

    constructor(private llm: LLMProvider) { }

    async handle(req: AgentRequest, ctx: Context): Promise<AgentResponse> {
        const userText =
            req.input.kind === "text"
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

        const convo =
            ctx.history.slice(-6).length === 0
                ? "(no prior conversation)"
                : ctx.history.slice(-6).map((t) => `${t.role}: ${t.message}`).join("\n");

        const system =
            "You are the Planner in the DaVinci assistant. You create and track the " +
            "user's goals over time. You know today's date and reason about real " +
            "timeframes.\n\n" +
            "TIMEFRAME — be sensible, NOT rigid:\n" +
            "- Compute the target end date from today's date and the user's " +
            "timeframe (e.g. '23 days' = today + 23 days; 'this month' = end of the " +
            "current month).\n" +
            "- Break the plan into whatever chunks NATURALLY fit that duration. " +
            "Do NOT force weeks. 23 days might be 3 phases of ~8 days, or milestone-" +
            "based. A weekend goal might be hours. Use your judgment and label each " +
            "phase honestly (e.g. 'Days 1-8', 'By June 15').\n" +
            "- Steps must be specific and progressive, sized to the real timeframe.\n\n" +
            "RESPONSE SCOPE:\n" +
            "- Reply about the plan the user is actually discussing. Do NOT recite " +
            "every plan. You MAY briefly mention another plan only if it's genuinely " +
            "relevant (e.g. scheduling conflict).\n\n" +
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

        const user =
            `Today is ${human} (${nowIso}).\n\n` +
            `Recent conversation:\n${convo}\n\n` +
            `Current plans (JSON):\n${JSON.stringify(existingPlans, null, 2)}\n\n` +
            `User message: ${userText}\n\n` +
            `If the message is a vague follow-up ("ok and", "continue", "what ` +
            `next"), interpret it using the conversation + plans — usually it means ` +
            `continue/expand the most recently discussed plan.\n` +
            `Return the updated state as JSON.`;

        let raw: string;
        try {
            raw = await this.llm.complete(
                [
                    { role: "system", content: system },
                    { role: "user", content: user },
                ],
                { temperature: 0.4 }
            );
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
                contractVersion: CONTRACT_VERSION,
                from: this.name,
                status: "error",
                message: "I couldn't update your plans right now.",
                diagnostics: [`planner LLM error: ${msg}`],
            };
        }

        const result = this.parse(raw);
        if (!result) {
            return {
                contractVersion: CONTRACT_VERSION,
                from: this.name,
                status: "partial",
                message:
                    "I understood your request but had trouble structuring the plan. " +
                    "Could you rephrase the goal?",
                diagnostics: ["planner: failed to parse LLM JSON"],
            };
        }

        return {
            contractVersion: CONTRACT_VERSION,
            from: this.name,
            status: "ok",
            message: result.reply,
            data: { planCount: result.plans.length },
            stateDelta: { plans: result.plans },
        };
    }

    private readPlans(ctx: Context): Plan[] {
        const raw = ctx.state.plans;
        return Array.isArray(raw) ? (raw as Plan[]) : [];
    }

    private parse(raw: string): PlannerLlmResult | null {
        const cleaned = raw.replace(/```json|```/g, "").trim();
        const start = cleaned.indexOf("{");
        const end = cleaned.lastIndexOf("}");
        if (start === -1 || end === -1 || end < start) return null;
        let obj: unknown;
        try {
            obj = JSON.parse(cleaned.slice(start, end + 1));
        } catch {
            return null;
        }
        if (typeof obj !== "object" || obj === null) return null;
        const o = obj as Record<string, unknown>;
        if (typeof o.reply !== "string" || !Array.isArray(o.plans)) return null;
        return { reply: o.reply, plans: o.plans as Plan[] };
    }
}