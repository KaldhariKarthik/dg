/**
 * src/agents/researcher.ts
 *
 * REAL agent. Answers questions via the LLM, CONTEXT-AWARE: it uses recent
 * conversation history (from ctx.history) so follow-ups like "what about its
 * population?" resolve against what was just discussed.
 *
 * It is ALSO document-grounded: when the server injects a document searcher
 * (backed by RecallService — the same corpus the voice assistant's
 * search_documents tool uses), the researcher retrieves relevant excerpts from
 * the user's OWN files and answers from them, naming the source. This is what
 * makes "what did I decide in that note?" work in text chat, not just by voice.
 * The dependency is optional: with no searcher it answers from general knowledge.
 */

import {
    Agent,
    AgentRequest,
    AgentResponse,
    Context,
    CONTRACT_VERSION,
} from "../core/types";
import { LLMProvider, LLMMessage } from "../llm/provider";

/** A minimal document-search port (server binds this to RecallService.search). */
export type DocSearcher = (
    userId: string,
    query: string,
    topK?: number
) => Promise<Array<{ docName: string; text: string; score: number }>>;

export class ResearcherAgent implements Agent {
    readonly name = "researcher" as const;

    constructor(private llm: LLMProvider, private docSearch?: DocSearcher) { }

    async handle(req: AgentRequest, ctx: Context): Promise<AgentResponse> {
        const question =
            req.input.kind === "text"
                ? req.input.text
                : `Based on this scene: ${req.input.text ?? "(image provided)"}`;

        // Ground the answer in the user's own documents when possible. Always
        // safe to try (returns [] when nothing is indexed); only inject context
        // for reasonably relevant hits so unrelated questions aren't derailed.
        let docContext = "";
        let usedDocs: string[] = [];
        if (this.docSearch && req.input.kind === "text" && question.trim()) {
            try {
                const hits = await this.docSearch(ctx.userId, question, 4);
                const relevant = hits.filter((h) => h.score >= 0.25);
                if (relevant.length) {
                    usedDocs = [...new Set(relevant.map((h) => h.docName))];
                    docContext =
                        "\n\nRelevant excerpts from the user's own documents " +
                        "(use these to answer when they apply, and name the " +
                        "document you drew from; ignore them if not relevant):\n" +
                        relevant
                            .map((h) => `[${h.docName}] ${h.text.slice(0, 500)}`)
                            .join("\n---\n");
                }
            } catch {
                // Recall is best-effort; fall back to general knowledge silently.
            }
        }

        const system =
            "You are the Researcher in a personal assistant system. Answer the " +
            "user's question clearly and concisely (2-4 sentences unless more " +
            "detail is needed). Use the conversation so far to resolve follow-up " +
            "questions. When excerpts from the user's own documents are provided " +
            "and relevant, answer from them and name the document. If you are not " +
            "certain, say so rather than guessing." +
            docContext;

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
                diagnostics: usedDocs.length
                    ? [`researcher: grounded in ${usedDocs.join(", ")}`]
                    : undefined,
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