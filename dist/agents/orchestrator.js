"use strict";
/**
 * src/agents/orchestrator.ts
 *
 * THE SPINE. The controller loop.
 *
 * Each step:
 *   1. ask the Router: which agent next, or finish?
 *   2. if finish -> assemble final answer, return.
 *   3. else dispatch to that agent via the registry.
 *   4. fold the agent's stateDelta into Context.state (so the planner's
 *      progress — and the vision agent's watch_for — persist into the next step).
 *   5. record the turn, repeat.
 *
 * THE SEATBELT: maxSteps. No matter what the router says, the loop cannot run
 * more than maxSteps times. An LLM router could otherwise ping-pong forever.
 * Gemini decides DIRECTION; this cap enforces a LIMIT. Both, always.
 *
 * THE TWO SOCKETS: the orchestrator imports neither concrete agents, nor the
 * concrete router, nor the concrete synthesizer — only interfaces + the
 * registry. The Router decides which agent acts; the Synthesizer decides what
 * the user finally hears. Swap either brain without editing this file.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.Orchestrator = void 0;
const types_1 = require("../core/types");
class Orchestrator {
    registry;
    router;
    synth;
    llm;
    memoryStore;
    opts;
    name = "orchestrator";
    constructor(registry, router, synth, llm, memoryStore, opts = {}) {
        this.registry = registry;
        this.router = router;
        this.synth = synth;
        this.llm = llm;
        this.memoryStore = memoryStore;
        this.opts = opts;
    }
    /**
     * Run one full turn: loop agents until the router finishes or the step cap
     * is hit, then synthesize a single assembled response for the user.
     */
    async run(req, ctx) {
        const maxSteps = this.opts.maxSteps ?? 8;
        const soFar = [];
        let steps = 0;
        let stopReason = "completed";
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
                // Guard: never finish having done nothing. If the router bails on the
                // very first step (e.g. an ambiguous "ok and"), force one agent call
                // so the user always gets a real response. Prefer the conversational
                // agent here — a no-work turn is usually filler, and it should NOT
                // leak into the researcher (or planner).
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
                    if (res.stateDelta)
                        ctx.state = { ...ctx.state, ...res.stateDelta };
                    ctx.history.push({
                        role: res.from,
                        message: res.message,
                        at: new Date().toISOString(),
                    });
                    stopReason = "forced one hop (router finished with no work)";
                }
                else {
                    stopReason = decision.reason;
                }
                break;
            }
            steps++;
            const agent = this.registry.get(decision.agent);
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
        // Run memory extraction in the background (asynchronous/non-blocking)
        this.updateMemory(ctx).catch(err => console.error("[memory] Background update failed:", err));
        return response;
    }
    /** Extract insights from conversation turns and update memory profile. */
    async updateMemory(ctx) {
        try {
            console.log("[memory] Starting background memory extraction...");
            const memory = await this.memoryStore.loadMemory("ctx.userId");
            // Get last 6 turns of history for extraction
            const recentHistory = ctx.history.slice(-6);
            if (recentHistory.length === 0)
                return;
            const conversationText = recentHistory.map(t => `${t.role}: ${t.message}`).join("\n");
            const system = "You are a memory extractor. Analyze the conversation history and update the user's memory profile.\n" +
                "Only extract information that is explicitly stated or strongly implied by the user.\n" +
                "Do not invent preferences, facts, or habits.\n" +
                "Return a strict JSON object matching this schema:\n" +
                "{\n" +
                "  \"preferences\": [\"key:value\", ...],\n" +
                "  \"past_patterns\": [\"recurring habit description\", ...],\n" +
                "  \"long_term_facts\": [\"long term fact description\", ...]\n" +
                "}";
            const user = `Current Memory Profile:\n${JSON.stringify(memory, null, 2)}\n\n` +
                `Recent Conversation:\n${conversationText}\n\n` +
                `Extract any new preferences, past patterns, or long-term facts, and output the updated entries as JSON.`;
            const raw = await this.llm.complete([
                { role: "system", content: system },
                { role: "user", content: user }
            ], { temperature: 0.1 });
            // Parse response
            const cleaned = raw.replace(/```json|```/g, "").trim();
            const start = cleaned.indexOf("{");
            const end = cleaned.lastIndexOf("}");
            if (start === -1 || end === -1 || end < start)
                return;
            const parsed = JSON.parse(cleaned.slice(start, end + 1));
            // Merge preferences
            if (Array.isArray(parsed.preferences)) {
                for (const pref of parsed.preferences) {
                    if (typeof pref === "string" && pref.includes(":")) {
                        const [k, v] = pref.split(":", 2);
                        memory.preferences[k.trim()] = v.trim();
                    }
                }
            }
            // Merge patterns
            if (Array.isArray(parsed.past_patterns)) {
                for (const pattern of parsed.past_patterns) {
                    if (typeof pattern === "string" && !memory.past_patterns.includes(pattern)) {
                        memory.past_patterns.push(pattern);
                    }
                }
            }
            // Merge facts
            if (Array.isArray(parsed.long_term_facts)) {
                for (const fact of parsed.long_term_facts) {
                    if (typeof fact === "string" && !memory.long_term_facts.includes(fact)) {
                        memory.long_term_facts.push(fact);
                    }
                }
            }
            await this.memoryStore.saveMemory("ctx.userId", memory);
            console.log("[memory] ✅ Memory updated successfully in Firestore/local.");
        }
        catch (e) {
            console.error("[memory] Failed to update memory:", e);
        }
    }
    /**
     * Fold the agents' outputs into one user-facing response.
     *
     * The human-readable `message` comes from the Synthesizer (single hop ->
     * verbatim; multiple hops -> fused into DaVinci's voice). Status and the
     * `data.steps` debug trace are computed here. We ALSO carry the last agent's
     * own `data` through as `data.result`, so structured directives survive
     * assembly (the vision bridge reads `data.result` to get watch_for/done).
     * Chat ignores `data` entirely — it only reads `message` — so this is
     * backward-compatible. Persistence already happened in the loop via
     * stateDelta; synthesis touches only the words.
     */
    async assemble(req, soFar, stopReason) {
        if (soFar.length === 0) {
            return {
                contractVersion: types_1.CONTRACT_VERSION,
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
            contractVersion: types_1.CONTRACT_VERSION,
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
exports.Orchestrator = Orchestrator;
//# sourceMappingURL=orchestrator.js.map