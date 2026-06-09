/**
 * src/agents/orchestrator.ts
 *
 * THE SPINE. The controller loop.
 *
 * Each step:
 *   1. ask the Router: which agent next, or finish?
 *   2. if finish -> assemble final answer, return.
 *   3. else dispatch to that agent via the registry.
 *   4. fold the agent's stateDelta into Context.state.
 *   5. record the turn, repeat.
 *
 * THE SEATBELT: maxSteps caps agent calls per turn no matter what the router says.
 *
 * MEMORY (v1.2): at the start of a turn the orchestrator LOADS the user's memory
 * onto ctx.memory so agents can READ it. After the turn it extracts any newly-
 * learned items and merges them ATOMICALLY (mergeMemory) — no more read-modify-
 * write race. Filler turns (conversational-only) are skipped entirely.
 */

import {
    Agent,
    AgentRequest,
    AgentResponse,
    Context,
    CONTRACT_VERSION,
    MemoryData,
} from "../core/types";
import { AgentRegistry } from "../core/registry";
import { Router } from "../core/router";
import { Synthesizer } from "../core/synthesizer";
import { LLMProvider } from "../llm/provider";
import { MemoryStore } from "../store/memoryStore";

export interface OrchestratorOptions {
    /** Hard upper bound on agent calls per turn. The seatbelt. */
    maxSteps?: number;
}

export class Orchestrator {
    readonly name = "orchestrator" as const;

    constructor(
        private registry: AgentRegistry,
        private router: Router,
        private synth: Synthesizer,
        private llm: LLMProvider,
        private memoryStore: MemoryStore,
        private opts: OrchestratorOptions = {}
    ) { }

    async run(req: AgentRequest, ctx: Context): Promise<AgentResponse> {
        const maxSteps = this.opts.maxSteps ?? 8;
        const soFar: AgentResponse[] = [];
        let steps = 0;
        let stopReason = "completed";

        // Load the user's memory ONCE per turn so any agent can read ctx.memory.
        // Non-fatal: if it fails, agents simply see no memory this turn.
        try {
            ctx.memory = await this.memoryStore.loadMemory(ctx.userId);
        } catch (e) {
            console.error("[memory] load failed (continuing without):", e);
        }

        // Does any agent hold an open interaction that this turn belongs to?
        // The router acts on this NAME without knowing the agent's internals.
        const claimedBy = await this.registry.resolveClaim(req.input, ctx);

        while (steps < maxSteps) {
            const decision = await this.router.decide({
                input: req.input,
                ctx,
                soFar,
                available: this.registry.available(),
                claimedBy,
            });

            if (decision.action === "finish") {
                // Guard: never finish having done nothing. Force one conversational
                // hop so the user always gets a real response.
                if (soFar.length === 0) {
                    const avail = this.registry.available();
                    const fallbackAgent = avail.includes("conversational")
                        ? "conversational"
                        : avail.includes("researcher")
                            ? "researcher"
                            : avail[0];
                    steps++;
                    const agent = this.registry.get(fallbackAgent);
                    const res = await agent.handle(req, ctx);
                    soFar.push(res);
                    if (res.stateDelta) ctx.state = { ...ctx.state, ...res.stateDelta };
                    ctx.history.push({
                        role: res.from,
                        message: res.message,
                        at: new Date().toISOString(),
                    });
                    stopReason = "forced one hop (router finished with no work)";
                } else {
                    stopReason = decision.reason;
                }
                break;
            }

            steps++;
            const agent: Agent = this.registry.get(decision.agent);
            const res = await agent.handle(req, ctx);
            soFar.push(res);

            if (res.stateDelta) {
                ctx.state = { ...ctx.state, ...res.stateDelta };
            }

            ctx.history.push({
                role: res.from,
                message: res.message,
                at: new Date().toISOString(),
            });
        }

        if (steps >= maxSteps) {
            stopReason = `step cap reached (${maxSteps})`;
        }

        const response = await this.assemble(req, soFar, stopReason);

        // Fix 2: AWAIT the memory update. It used to be fire-and-forget, but on
        // Cloud Run with default CPU throttling, work kicked off AFTER the response
        // is sent may never run — silently dropping everything DaVinci learns.
        // updateMemory swallows its own errors (try/catch within), so awaiting it
        // can never break the turn; it only adds the extraction latency (one LLM
        // call) to SUBSTANTIVE chat turns. Vision/orchestrate turns pass an empty
        // history, so updateMemory returns immediately and the fast path is
        // unaffected. (If you later run Cloud Run with --no-cpu-throttling or
        // min-instances>=1, you can move this back to fire-and-forget for snappier
        // chat replies.)
        await this.updateMemory(ctx, soFar);

        return response;
    }

    /**
     * Extract NEW durable items from the turn and merge them atomically. Skips
     * filler turns and no-op deltas so memory stays meaningful and cheap. Never
     * throws — all failures are logged and swallowed so the caller can await it
     * safely.
     */
    private async updateMemory(ctx: Context, soFar: AgentResponse[]): Promise<void> {
        try {
            // Filler skip: a conversational-only turn (greetings, "hmm", thanks)
            // carries nothing worth remembering.
            if (soFar.length > 0 && soFar.every((r) => r.from === "conversational")) {
                return;
            }

            const recentHistory = ctx.history.slice(-6);
            if (recentHistory.length === 0) return;

            const conversationText = recentHistory
                .map((t) => `${t.role}: ${t.message}`)
                .join("\n");
            const current = ctx.memory ?? (await this.memoryStore.loadMemory(ctx.userId));

            const system =
                "You extract NEW, durable facts about the user from a conversation, " +
                "to update their long-term memory. Extract ONLY what the user " +
                "explicitly stated or clearly implied about THEMSELVES. Never invent. " +
                "Ignore one-off task details (a single date, a single question). " +
                "Capture stable preferences, recurring habits, and lasting facts.\n" +
                "Return STRICT JSON only, no markdown — ONLY items that are NEW " +
                "relative to the current profile:\n" +
                "{\n" +
                '  "preferences": ["key:value", ...],\n' +
                '  "past_patterns": ["recurring habit", ...],\n' +
                '  "long_term_facts": ["durable fact", ...]\n' +
                "}\n" +
                "Use empty arrays if there is nothing new.";

            const user =
                `Current profile:\n${JSON.stringify(current, null, 2)}\n\n` +
                `Recent conversation:\n${conversationText}\n\n` +
                `Output ONLY new items as JSON.`;

            const raw = await this.llm.complete(
                [
                    { role: "system", content: system },
                    { role: "user", content: user },
                ],
                { temperature: 0.1 }
            );

            const delta = this.parseMemoryDelta(raw);
            if (!delta) return;

            const empty =
                Object.keys(delta.preferences).length === 0 &&
                delta.past_patterns.length === 0 &&
                delta.long_term_facts.length === 0;
            if (empty) return;

            await this.memoryStore.mergeMemory(ctx.userId, delta);
            console.log("[memory] merged new items into profile.");
        } catch (e) {
            console.error("[memory] update failed:", e);
        }
    }

    /** Parse the extractor's JSON into a MemoryData delta. Tolerant of fences. */
    private parseMemoryDelta(raw: string): MemoryData | null {
        const cleaned = raw.replace(/```json|```/g, "").trim();
        const start = cleaned.indexOf("{");
        const end = cleaned.lastIndexOf("}");
        if (start === -1 || end === -1 || end < start) return null;
        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(cleaned.slice(start, end + 1));
        } catch {
            return null;
        }
        if (typeof parsed !== "object" || parsed === null) return null;

        const preferences: Record<string, string> = {};
        if (Array.isArray(parsed.preferences)) {
            for (const pref of parsed.preferences) {
                // Split on the FIRST colon only, so values may contain colons.
                if (typeof pref === "string" && pref.includes(":")) {
                    const i = pref.indexOf(":");
                    const k = pref.slice(0, i).trim();
                    const v = pref.slice(i + 1).trim();
                    if (k && v) preferences[k] = v;
                }
            }
        }
        const past_patterns = Array.isArray(parsed.past_patterns)
            ? (parsed.past_patterns as unknown[]).filter((x): x is string => typeof x === "string")
            : [];
        const long_term_facts = Array.isArray(parsed.long_term_facts)
            ? (parsed.long_term_facts as unknown[]).filter((x): x is string => typeof x === "string")
            : [];

        return { preferences, past_patterns, long_term_facts };
    }

    private async assemble(
        req: AgentRequest,
        soFar: AgentResponse[],
        stopReason: string
    ): Promise<AgentResponse> {
        if (soFar.length === 0) {
            return {
                contractVersion: CONTRACT_VERSION,
                from: this.name,
                status: "error",
                message: "No agent produced a response.",
                diagnostics: [`stopReason: ${stopReason}`],
            };
        }

        const worstStatus = soFar.some((r) => r.status === "error")
            ? "error"
            : soFar.some((r) => r.status === "partial")
                ? "partial"
                : "ok";

        const message = await this.synth.synthesize({
            input: req.input,
            soFar,
        });

        const last = soFar[soFar.length - 1];

        return {
            contractVersion: CONTRACT_VERSION,
            from: this.name,
            status: worstStatus,
            message,
            data: {
                steps: soFar.map((r) => ({ from: r.from, status: r.status })),
                result: last.data,
            },
            diagnostics: [`stopReason: ${stopReason}`],
        };
    }
}