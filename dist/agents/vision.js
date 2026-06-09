"use strict";
/**
 * src/agents/vision.ts
 *
 * REAL agent. Turns a structured scene observation (the v1.0 envelope the
 * perception edge emits) into a DIRECTIVE: what to say, what to keep watching
 * for, whether a watched condition is satisfied, and — in a guided session —
 * whether a plan step is now complete.
 *
 * Perception (the /api/vision model) DESCRIBES; this agent DECIDES. It never
 * sees raw pixels — only the structured scene. The observation shape it reads is
 * the SHARED VisionObservation type from the contract (no private schema copy).
 *
 * TWO MODES:
 *   describe  — plain camera. Answer questions, flag hazards, manage watch_for.
 *   guided    — a user-started session bound to ONE active plan (injected by the
 *               server into ctx.state.activePlan). The agent reasons against that
 *               plan + the user's memory, coaches the next step, warns on
 *               task-relevant hazards, and manages step completion.
 *
 * WRITES & THE GUARDRAIL (6B): in guided mode the agent may emit `step_action`
 * (an index to mark done) ONLY when it can SEE the step is clearly complete. When
 * a step looks plausibly-but-not-certainly done, it emits `confirm` (a spoken
 * question) and writes NOTHING until the user answers. The check-off itself is
 * silent — the spoken line coaches the NEXT step, never "checked off step 2".
 * A warm oven is not a baked pizza; weak evidence is never completion.
 *
 * The agent never persists frames (perception is stateless). Only watch_for and
 * a pending confirmation carry across frames, via ctx.state.vision.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.VisionAgent = void 0;
const types_1 = require("../core/types");
/** The user's memory as optional context (guardrailed: context, not a script). */
function memoryNote(ctx) {
    const m = ctx.memory;
    if (!m)
        return "";
    const has = Object.keys(m.preferences).length || m.past_patterns.length || m.long_term_facts.length;
    if (!has)
        return "";
    const prefs = Object.entries(m.preferences).map(([k, v]) => `${k}: ${v}`).join("; ") || "none";
    return (`\nWhat you know about this user (context only, never override what you see): ` +
        `preferences [${prefs}]; patterns [${m.past_patterns.join("; ") || "none"}]; ` +
        `facts [${m.long_term_facts.join("; ") || "none"}].`);
}
/** A compact, indexed view of the plan being guided. */
function planView(plan) {
    const steps = plan.steps
        .map((s, i) => `${i}. ${s.done ? "[x]" : "[ ]"} ${s.phase ? `(${s.phase}) ` : ""}${s.text}`)
        .join("\n");
    return (`Goal: ${plan.goal}\n` +
        `Steps (use the leading number as the step index):\n${steps || "(no steps yet)"}`);
}
class VisionAgent {
    llm;
    name = "vision";
    constructor(llm) {
        this.llm = llm;
    }
    async handle(req, ctx) {
        if (req.input.kind !== "scene") {
            return {
                contractVersion: types_1.CONTRACT_VERSION,
                from: this.name,
                status: "error",
                message: "",
                diagnostics: ["vision: received non-scene input"],
            };
        }
        const env = (req.input.scene ?? {});
        const scene = (env.scene ?? {});
        const transcript = req.input.text?.trim() ||
            (env.user_flags?.user_transcript ?? "").trim();
        const priorVision = ctx.state.vision ?? {};
        const watchFor = priorVision.watch_for ?? null;
        const pendingConfirm = priorVision.pendingConfirm ?? null;
        const guided = ctx.state.sessionMode === "guided";
        const activePlan = guided ? ctx.state.activePlan : undefined;
        const objects = Array.isArray(scene.objects)
            ? scene.objects
                .map((o) => `${o.label}${o.state ? ` (${o.state})` : ""}${o.position ? ` @ ${o.position}` : ""}`)
                .join(", ")
            : "";
        const anomalies = Array.isArray(scene.anomalies)
            ? scene.anomalies.map((a) => `${a.type}: ${a.description}`).join("; ")
            : "";
        const sceneText = `summary: ${scene.summary || "(none)"}\n` +
            `environment: ${scene.environment || "unknown"}\n` +
            `objects: ${objects || "(none)"}\n` +
            `anomalies: ${anomalies || "(none)"}`;
        const task = activePlan?.goal || env.task_context?.task || "(not set)";
        const mode = env.task_context?.mode || "observe";
        const useGuided = guided && !!activePlan;
        const system = useGuided ? this.guidedSystem() : this.describeSystem();
        const user = useGuided
            ? `You are guiding the user through this plan:\n${planView(activePlan)}` +
                memoryNote(ctx) +
                `\n\nActive watch_for: ${watchFor ?? "(none)"}\n` +
                `Pending confirmation: ${pendingConfirm
                    ? `you asked about step ${pendingConfirm.index}: "${pendingConfirm.question}"`
                    : "(none)"}\n` +
                `User said: ${transcript || "(nothing)"}\n\n` +
                `Scene:\n${sceneText}\n\n` +
                `Decide. JSON only.`
            : `Task: ${task} (mode: ${mode})\n` +
                `Active watch_for: ${watchFor ?? "(none)"}\n` +
                `User said: ${transcript || "(nothing)"}\n\n` +
                `Scene:\n${sceneText}\n\n` +
                `Decide. JSON only.`;
        let decision = null;
        try {
            const raw = await this.llm.complete([
                { role: "system", content: system },
                { role: "user", content: user },
            ], { temperature: 0.2 });
            decision = this.parse(raw);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
                contractVersion: types_1.CONTRACT_VERSION,
                from: this.name,
                status: "error",
                message: "",
                diagnostics: [`vision LLM error: ${msg}`],
            };
        }
        if (!decision) {
            // Couldn't parse — stay silent, but KEEP watch_for + pendingConfirm so
            // neither loop is dropped.
            return {
                contractVersion: types_1.CONTRACT_VERSION,
                from: this.name,
                status: "partial",
                message: "",
                data: { watch_for: watchFor, done: false, done_message: "", step_action: null, confirm: pendingConfirm },
                stateDelta: {
                    vision: { watch_for: watchFor, pendingConfirm, updatedAt: new Date().toISOString() },
                },
                diagnostics: ["vision: failed to parse decision JSON"],
            };
        }
        const nextWatch = decision.done ? null : decision.watch_for ?? null;
        // Validate step_action against the active plan; only act on [ ] steps.
        const stepAction = this.validateStepAction(decision.step_action, activePlan);
        // The agent owns the pendingConfirm lifecycle (like watch_for): its value
        // IS the next pending confirmation; null clears it.
        const nextConfirm = stepAction !== null ? null : decision.confirm ?? null;
        return {
            contractVersion: types_1.CONTRACT_VERSION,
            from: this.name,
            status: "ok",
            message: decision.guidance ?? "",
            data: {
                guidance: decision.guidance ?? "",
                watch_for: nextWatch,
                done: !!decision.done,
                done_message: decision.done_message ?? "",
                step_action: stepAction,
                confirm: nextConfirm,
            },
            stateDelta: {
                vision: {
                    watch_for: nextWatch,
                    pendingConfirm: nextConfirm,
                    updatedAt: new Date().toISOString(),
                },
            },
        };
    }
    /** Only let the agent check off a real, not-yet-done step. */
    validateStepAction(index, plan) {
        if (index === null || !plan)
            return null;
        if (!Number.isInteger(index) || index < 0 || index >= plan.steps.length)
            return null;
        if (plan.steps[index].done)
            return null; // already done — nothing to do
        return index;
    }
    /** Plain-camera reasoning (unchanged behavior). */
    describeSystem() {
        return ("You are DaVinci's vision reasoner. You receive a STRUCTURED " +
            "description of one camera frame (not the image) plus optional task " +
            "context, the user's spoken question, and an active condition you were " +
            "asked to watch for. Decide what — if anything — to say, and manage the " +
            "watch condition.\n\n" +
            "RULES:\n" +
            "- If the user asked a question, answer it in ONE short spoken sentence " +
            "using only what's visible.\n" +
            "- If a watch_for condition is active: judge from the scene whether it is " +
            "NOW satisfied. If yes -> done=true, write a short done_message, set " +
            "watch_for to null. If not yet -> done=false, KEEP the same watch_for, and " +
            'usually stay silent (guidance="").\n' +
            "- If the user asks you to watch for something ('tell me when the water " +
            "boils') -> set watch_for to that condition and briefly acknowledge.\n" +
            "- With no question and no watch_for: speak ONLY if there's a genuine " +
            'warning/danger anomaly worth flagging. Otherwise guidance="".\n' +
            "- Never mention frames, JSON, or that you are an agent. Speak naturally.\n\n" +
            "Return STRICT JSON only, no markdown:\n" +
            '{"guidance":"<short line or empty>","watch_for":"<condition or null>",' +
            '"done":false,"done_message":"","step_action":null,"confirm":null}');
    }
    /** Guided-session reasoning: coach, warn, and manage step completion. */
    guidedSystem() {
        return ("You are DaVinci's vision reasoner, GUIDING the user hands-on through a " +
            "specific plan you are given. You see a structured description of one " +
            "camera frame (not the image), the plan with each step marked [x] done " +
            "or [ ] not done and a leading index number, what you know about the " +
            "user, their spoken question, any active watch condition, and any " +
            "pending confirmation you previously asked. You are a calm expert " +
            "standing beside them.\n\n" +
            "COACHING:\n" +
            "- Work out from the scene which step they're on, and COACH the next " +
            "not-yet-done step in ONE short, natural spoken line — but only at a " +
            "natural moment (a step just finished, they're between steps, or they " +
            'ask). On a routine frame with nothing new, stay silent (guidance="").\n' +
            "- Guide forward like a person ('nice, dough's resting — get the oven as " +
            "hot as it goes with the stone in'). Never read out bookkeeping.\n" +
            "- WARN aloud about task-relevant hazards: something unsafe, a step out " +
            "of order, or an expected item missing (an empty pan heating, oven cold " +
            "at bake time).\n" +
            "- Answer a spoken question in ONE short sentence from what's visible.\n\n" +
            "WRITING TO THE PLAN — be careful, this is the important part:\n" +
            "- When you can SEE that a [ ] step is clearly complete (high " +
            "confidence), set step_action to that step's index. The check-off is " +
            "SILENT — do NOT say 'checked that off'; instead coach the next step in " +
            "guidance. A warm oven is NOT a baked pizza; weak evidence is never " +
            "completion.\n" +
            "- When a step looks plausibly done but you are NOT sure, do NOT write. " +
            "Set confirm to {index, question} with a short spoken question, and put " +
            "that SAME question in guidance. step_action MUST be null.\n" +
            "- If there is a pending confirmation and the user just answered it: if " +
            "they confirmed (yes / that's done), set step_action to that index and " +
            "confirm=null; if they declined or it's clearly not done, set " +
            "step_action=null and confirm=null.\n" +
            "- NEVER set both step_action and confirm. Only ever act on [ ] steps.\n" +
            "- Judge only from what's actually visible. Never invent progress.\n\n" +
            "Watch conditions still work: set watch_for for a 'tell me when…', clear " +
            "it and set done=true when satisfied.\n" +
            "Never mention frames, JSON, step numbers, plans-as-data, or that you " +
            "are an agent. Speak like a human guide.\n\n" +
            "Return STRICT JSON only, no markdown:\n" +
            '{"guidance":"<short spoken line or empty>","watch_for":"<condition or null>",' +
            '"done":false,"done_message":"","step_action":<step index or null>,' +
            '"confirm":<null or {"index":<step index>,"question":"<short question>"}>}');
    }
    parse(raw) {
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
        let confirm = null;
        if (obj.confirm && typeof obj.confirm === "object") {
            const idx = obj.confirm.index;
            const q = obj.confirm.question;
            if (Number.isInteger(idx) && typeof q === "string" && q.trim()) {
                confirm = { index: idx, question: q.trim() };
            }
        }
        return {
            guidance: typeof obj.guidance === "string" ? obj.guidance : "",
            watch_for: typeof obj.watch_for === "string" && obj.watch_for.trim()
                ? obj.watch_for
                : null,
            done: !!obj.done,
            done_message: typeof obj.done_message === "string" ? obj.done_message : "",
            step_action: Number.isInteger(obj.step_action) ? obj.step_action : null,
            confirm,
        };
    }
}
exports.VisionAgent = VisionAgent;
//# sourceMappingURL=vision.js.map