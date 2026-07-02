/**
 * src/agents/researcher.ts
 *
 * REAL agent. Answers questions via the LLM, now CONTEXT-AWARE: it uses recent
 * conversation history (from ctx.history) so follow-ups like "what about its
 * population?" resolve against what was just discussed.
 */

import {
    Agent,
    AgentRequest,
    AgentResponse,
    Context,
    CONTRACT_VERSION,
} from "../core/types";
import { LLMProvider, LLMMessage } from "../llm/provider";

export class ResearcherAgent implements Agent {
    readonly name = "researcher" as const;

    constructor(private llm: LLMProvider) { }

    async handle(req: AgentRequest, ctx: Context): Promise<AgentResponse> {
        const question =
            req.input.kind === "text"
                ? req.input.text
                : `Based on this scene: ${req.input.text ?? "(image provided)"}`;

        const system =
            "You are the Researcher in a personal assistant system. Answer the " +
            "user's question clearly and concisely (2-4 sentences unless more " +
            "detail is needed). Use the conversation so far to resolve follow-up " +
            "questions. If you are not certain, say so rather than guessing.";

        // Feed recent history (last ~6 turns) as context, then the new question.
        const recent: LLMMessage[] = ctx.history.slice(-6).map((t) => ({
            role: t.role === "user" ? "user" : "model",
            content: t.message,
        }));

        try {
            const answer = await this.llm.complete(
                [
                    { role: "system", content: system },
                    ...recent,
                    { role: "user", content: question },
                ],
                { temperature: 0.3 }
            );
            return {
                contractVersion: CONTRACT_VERSION,
                from: this.name,
                status: "ok",
                message: answer.trim(),
            };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
                contractVersion: CONTRACT_VERSION,
                from: this.name,
                status: "error",
                message: "I couldn't complete that lookup right now.",
                diagnostics: [`researcher LLM error: ${msg}`],
            };
        }
    }
}