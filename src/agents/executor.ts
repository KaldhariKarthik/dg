/**
 * src/agents/executor.ts
 *
 * DUMMY for now. The executor will eventually act on adapters (Gmail,
 * Calendar, Notes), which means OAuth + real side effects — a focused job for
 * its own session. Until then it acknowledges the action without performing
 * it, so the orchestrator can route to it and the system stays whole.
 *
 * It implements the SAME Agent contract, so making it real later changes only
 * this file.
 */

import {
    Agent,
    AgentRequest,
    AgentResponse,
    Context,
    CONTRACT_VERSION,
} from "../core/types";

export class ExecutorAgent implements Agent {
    readonly name = "executor" as const;

    async handle(req: AgentRequest, _ctx: Context): Promise<AgentResponse> {
        const text =
            req.input.kind === "text"
                ? req.input.text
                : req.input.text ?? "[scene]";

        return {
            contractVersion: CONTRACT_VERSION,
            from: this.name,
            status: "ok",
            message:
                `I'd carry out that action ("${text}"), but my executor isn't ` +
                `connected to your apps (Gmail, Calendar, Notes) yet.`,
            data: { action: "noop", performed: false },
        };
    }
}