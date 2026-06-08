/**
 * src/agents/vision.ts
 *
 * REAL agent. Turns a structured scene observation (the v1.0 envelope the
 * perception edge emits) into a DIRECTIVE: what to say, what to keep watching
 * for, and whether a watched condition is now satisfied.
 *
 * Perception (the /api/vision model) DESCRIBES; this agent DECIDES. It never
 * sees raw pixels — only the structured scene — so it stays cheap and the two
 * concerns stay cleanly split. The observation shape it reads is now the SHARED
 * VisionObservation type from the contract (no private copy of the schema).
 *
 * Closed loop: the active `watch_for` condition is persisted in session state
 * (ctx.state.vision), so the SERVER is the source of truth across frames. Each
 * forwarded observation, the agent re-checks it; when satisfied it emits done.
 */

import {
    Agent,
    AgentRequest,
    AgentResponse,
    Context,
    CONTRACT_VERSION,
    VisionObservation,
    VisionScene,
    SceneObject,
    SceneAnomaly,
} from "../core/types";
import { LLMProvider } from "../llm/provider";

interface VisionState {
    watch_for?: string | null;
    updatedAt?: string;
}

interface VisionDecision {
    guidance: string;
    watch_for: string | null;
    done: boolean;
    done_message: string;
}

export class VisionAgent implements Agent {
    readonly name = "vision" as const;

    constructor(private llm: LLMProvider) { }

    async handle(req: AgentRequest, ctx: Context): Promise<AgentResponse> {
        if (req.input.kind !== "scene") {
            // Defensive: vision only handles scene input. Shouldn't happen, since
            // the router only routes scenes here.
            return {
                contractVersion: CONTRACT_VERSION,
                from: this.name,
                status: "error",
                message: "",
                diagnostics: ["vision: received non-scene input"],
            };
        }

        // The scene rides as `unknown` on the contract; here we read it as the
        // shared v1.0 envelope (partial — a model can always omit a field).
        const env = (req.input.scene ?? {}) as Partial<VisionObservation>;
        const scene = (env.scene ?? {}) as Partial<VisionScene>;
        const transcript =
            req.input.text?.trim() ||
            (env.user_flags?.user_transcript ?? "").trim();

        const priorVision = (ctx.state.vision as VisionState) ?? {};
        const watchFor = priorVision.watch_for ?? null;

        // Compact, text-only view of the scene for the reasoning call.
        const objects = Array.isArray(scene.objects)
            ? scene.objects
                .map(
                    (o: SceneObject) =>
                        `${o.label}${o.state ? ` (${o.state})` : ""}${o.position ? ` @ ${o.position}` : ""}`
                )
                .join(", ")
            : "";
        const anomalies = Array.isArray(scene.anomalies)
            ? scene.anomalies.map((a: SceneAnomaly) => `${a.type}: ${a.description}`).join("; ")
            : "";

        const sceneText =
            `summary: ${scene.summary || "(none)"}\n` +
            `environment: ${scene.environment || "unknown"}\n` +
            `objects: ${objects || "(none)"}\n` +
            `anomalies: ${anomalies || "(none)"}`;

        const task = env.task_context?.task || "(not set)";
        const mode = env.task_context?.mode || "observe";

        const system =
            "You are DaVinci's vision reasoner. You receive a STRUCTURED " +
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
            '"done":false,"done_message":""}';

        const user =
            `Task: ${task} (mode: ${mode})\n` +
            `Active watch_for: ${watchFor ?? "(none)"}\n` +
            `User said: ${transcript || "(nothing)"}\n\n` +
            `Scene:\n${sceneText}\n\n` +
            `Decide. JSON only.`;

        let decision: VisionDecision | null = null;
        try {
            const raw = await this.llm.complete(
                [
                    { role: "system", content: system },
                    { role: "user", content: user },
                ],
                { temperature: 0.2 }
            );
            decision = this.parse(raw);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
                contractVersion: CONTRACT_VERSION,
                from: this.name,
                status: "error",
                message: "",
                diagnostics: [`vision LLM error: ${msg}`],
            };
        }

        if (!decision) {
            // Couldn't parse — stay silent rather than speak garbage, but KEEP the
            // existing watch_for so the loop isn't dropped.
            return {
                contractVersion: CONTRACT_VERSION,
                from: this.name,
                status: "partial",
                message: "",
                data: { watch_for: watchFor, done: false, done_message: "" },
                diagnostics: ["vision: failed to parse decision JSON"],
            };
        }

        const nextWatch = decision.done ? null : decision.watch_for ?? null;

        return {
            contractVersion: CONTRACT_VERSION,
            from: this.name,
            status: "ok",
            message: decision.guidance ?? "",
            data: {
                guidance: decision.guidance ?? "",
                watch_for: nextWatch,
                done: !!decision.done,
                done_message: decision.done_message ?? "",
            },
            stateDelta: {
                vision: { watch_for: nextWatch, updatedAt: new Date().toISOString() },
            },
        };
    }

    private parse(raw: string): VisionDecision | null {
        const cleaned = raw.replace(/```json|```/g, "").trim();
        const start = cleaned.indexOf("{");
        const end = cleaned.lastIndexOf("}");
        if (start === -1 || end === -1 || end < start) return null;
        let obj: any;
        try {
            obj = JSON.parse(cleaned.slice(start, end + 1));
        } catch {
            return null;
        }
        if (typeof obj !== "object" || obj === null) return null;
        return {
            guidance: typeof obj.guidance === "string" ? obj.guidance : "",
            watch_for:
                typeof obj.watch_for === "string" && obj.watch_for.trim()
                    ? obj.watch_for
                    : null,
            done: !!obj.done,
            done_message: typeof obj.done_message === "string" ? obj.done_message : "",
        };
    }
}