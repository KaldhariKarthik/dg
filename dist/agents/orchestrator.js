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
 *      progress persists into the next step).
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
    opts;
    name = "orchestrator";
    constructor(registry, router, synth, opts = {}) {
        this.registry = registry;
        this.router = router;
        this.synth = synth;
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
        while (steps < maxSteps) {
            const decision = await this.router.decide({
                input: req.input,
                ctx,
                soFar,
                available: this.registry.available(),
            });
            if (decision.action === "finish") {
                // Guard: never finish having done nothing. If the router bails on the
                // very first step (e.g. an ambiguous "ok and"), force one agent call
                // so the user always gets a real response.
                if (soFar.length === 0) {
                    const fallbackAgent = this.registry.available().includes("researcher")
                        ? "researcher"
                        : this.registry.available()[0];
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
        return this.assemble(req, soFar, stopReason);
    }
    /**
     * Fold the agents' outputs into one user-facing response.
     *
     * The human-readable `message` now comes from the Synthesizer (single hop ->
     * verbatim; multiple hops -> fused into DaVinci's voice). Status and the
     * `data.steps` debug trace are computed here as before. Persistence already
     * happened in the loop via stateDelta, so synthesis touches only the words.
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
        return {
            contractVersion: types_1.CONTRACT_VERSION,
            from: this.name,
            status: worstStatus,
            message,
            data: { steps: soFar.map((r) => ({ from: r.from, status: r.status })) },
            diagnostics: [`stopReason: ${stopReason}`],
        };
    }
}
exports.Orchestrator = Orchestrator;
//# sourceMappingURL=orchestrator.js.map