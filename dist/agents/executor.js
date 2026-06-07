"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExecutorAgent = void 0;
const types_1 = require("../core/types");
class ExecutorAgent {
    name = "executor";
    async handle(req, _ctx) {
        const text = req.input.kind === "text"
            ? req.input.text
            : req.input.text ?? "[scene]";
        return {
            contractVersion: types_1.CONTRACT_VERSION,
            from: this.name,
            status: "ok",
            message: `I'd carry out that action ("${text}"), but my executor isn't ` +
                `connected to your apps (Gmail, Calendar, Notes) yet.`,
            data: { action: "noop", performed: false },
        };
    }
}
exports.ExecutorAgent = ExecutorAgent;
//# sourceMappingURL=executor.js.map