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

import {
    Agent,
    AgentRequest,
    AgentResponse,
    Context,
    CONTRACT_VERSION,
} from "../core/types";
import { AgentRegistry } from "../core/registry";
import { Router } from "../core/router";
import { Synthesizer } from "../core/synthesizer";

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
        private opts: OrchestratorOptions = {}
    ) { }

    /**
     * Run one full turn: loop agents until the router finishes or the step cap
     * is hit, then synthesize a single assembled response for the user.
     */
    async run(req: AgentRequest, ctx: Context): Promise<AgentResponse> {
        const maxSteps = this.opts.maxSteps ?? 8;
        const soFar: AgentResponse[] = [];
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

        return {
            contractVersion: CONTRACT_VERSION,
            from: this.name,
            status: worstStatus,
            message,
            data: { steps: soFar.map((r) => ({ from: r.from, status: r.status })) },
            diagnostics: [`stopReason: ${stopReason}`],
        };
    }
}