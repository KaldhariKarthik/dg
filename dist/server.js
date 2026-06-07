"use strict";
/**
 * src/server.ts — the HTTP edge. THE SINGLE SERVER ENTRYPOINT.
 *
 * (The old root-level server.js is gone. It split the app in two and imported
 * @google/generative-ai, a package no longer in package.json — so it couldn't
 * even start. Everything it did well now lives here.)
 *
 * Routes — exactly the shapes the website already speaks:
 *   POST /api/chat    { message, sessionId?, history? }        -> { reply }
 *   POST /api/vision  { image, tier?, task_context?, ... }     -> v1.0 envelope
 *   static serving of public/
 *
 * /api/chat flows through the orchestrator (researcher/planner/executor routed
 * by Gemini) — the website doesn't notice, same request, same { reply }.
 *
 * /api/vision is the PERCEPTION EDGE: one frame -> the structured v1.0
 * observation the client expects. It is pure description; it never decides what
 * to SAY. That observation is the seam where a real VisionAgent will later feed
 * the orchestrator as a SceneInput.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const genai_1 = require("@google/genai");
const types_1 = require("./core/types");
const registry_1 = require("./core/registry");
const router_1 = require("./core/router");
const orchestrator_1 = require("./agents/orchestrator");
const researcher_1 = require("./agents/researcher");
const planner_1 = require("./agents/planner");
const executor_1 = require("./agents/executor");
const conversational_1 = require("./agents/conversational");
const gemini_1 = require("./llm/gemini");
const fileStore_1 = require("./store/fileStore");
const synthesizer_1 = require("./core/synthesizer");
// --- config -----------------------------------------------------------------
const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const apiKey = process.env.GEMINI_API_KEY ?? process.env.API_KEY;
// Vision model tiers. fast = high-frequency streaming path (cheap, low-latency);
// deep = explicit user questions / harder visual reasoning. The client picks
// the tier per frame via `tier: "fast" | "deep"`.
const VISION_MODEL_FAST = "gemini-3.1-flash-lite";
const VISION_MODEL_DEEP = "gemini-3.5-flash";
if (!apiKey) {
    console.error("[fatal] No API key found (set API_KEY or GEMINI_API_KEY in .env). " +
        "The researcher and planner agents require it.");
    process.exit(1);
}
// --- wiring (built once at startup) -----------------------------------------
const gemini = new gemini_1.GeminiProvider({ apiKey });
console.log(`[brain] Gemini active (${gemini.modelId})`);
const registry = new registry_1.AgentRegistry();
registry.register(new researcher_1.ResearcherAgent(gemini)); // real
registry.register(new planner_1.PlannerAgent(gemini)); // real
registry.register(new executor_1.ExecutorAgent()); // dummy (no LLM needed yet)
registry.register(new conversational_1.ConversationalAgent(gemini)); // real
// LlmRouter is the brain; KeywordRouter stays available as a fallback class.
const router = new router_1.LlmRouter(gemini);
void router_1.KeywordRouter; // kept intentionally for future fallback wiring
// LlmSynthesizer fuses multi-agent turns into one DaVinci voice;
// LastMessageSynthesizer stays available as the no-key / test fallback.
const synth = new synthesizer_1.LlmSynthesizer(gemini);
void synthesizer_1.LastMessageSynthesizer;
const orchestrator = new orchestrator_1.Orchestrator(registry, router, synth, { maxSteps: 8 });
const store = new fileStore_1.FileStore();
// Raw Gemini client for the perception endpoint.
const visionAI = new genai_1.GoogleGenAI({ apiKey });
// --- app --------------------------------------------------------------------
const app = (0, express_1.default)();
app.use(express_1.default.json({ limit: "10mb" }));
app.use((0, cors_1.default)()); // permissive for dev; tighten when deployment is known
app.use(express_1.default.static("public"));
// POST /api/chat -------------------------------------------------------------
app.post("/api/chat", async (req, res) => {
    try {
        const { message, sessionId, history } = req.body;
        if (!message) {
            return res.status(400).json({ error: "message is required." });
        }
        const sid = sessionId ?? "default";
        // Load durable server-side state (plans + conversation) for this session.
        const state = await store.load(sid);
        let storedHistory = Array.isArray(state.conversation)
            ? state.conversation
            : [];
        if (storedHistory.length === 0 && Array.isArray(history)) {
            storedHistory = history.map((h) => ({
                role: h.role === "user" ? "user" : "researcher",
                message: (h.parts ?? []).map((p) => p.text ?? "").join(" "),
                at: new Date().toISOString(),
            }));
        }
        // Append the new user message to history before running the turn.
        storedHistory.push({
            role: "user",
            message,
            at: new Date().toISOString(),
        });
        const ctx = {
            sessionId: sid,
            state,
            history: storedHistory,
            startedAt: new Date().toISOString(),
        };
        const agentReq = {
            contractVersion: types_1.CONTRACT_VERSION,
            input: { kind: "text", text: message },
        };
        const result = await orchestrator.run(agentReq, ctx);
        // The orchestrator appended agent turns to ctx.history during the run.
        // Persist the full conversation (trimmed) plus whatever plan/state the
        // agents updated.
        ctx.state.conversation = ctx.history.slice(-40); // keep last 40 turns
        await store.save(sid, ctx.state);
        // Map the rich AgentResponse down to the website's { reply } contract.
        res.json({ reply: result.message });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("Chat error:", msg);
        res.status(500).json({ error: msg });
    }
});
// POST /api/vision -----------------------------------------------------------
// Perception edge: one frame -> structured v1.0 observation envelope. Pure
// description. The client decides when to forward an observation upward; the
// orchestrator (not this endpoint) decides what to say back.
const VISION_SYSTEM = `You are DaVinci's vision module. You receive one camera frame plus optional task context,
recent scene summaries, and an optional user transcript. Reply with ONE JSON object and nothing else —
no markdown, no code fences, no prose. Describe only what is actually visible; never invent detail.
Use the task context to judge relevance and to flag expected-but-missing items.

Output exactly this shape:
{
  "task_context": { "task": string, "mode": string },
  "scene": {
    "summary": string,
    "environment": string,
    "objects": [
      { "id": string, "label": string, "state": string, "position": string|null, "confidence": number }
    ],
    "spatial_layout": { "description": string, "dimensions_available": boolean },
    "anomalies": [ { "type": string, "description": string } ]
  },
  "user_flags": { "explicitly_mentioned": string[] }
}

Rules:
- object id: sequential, "obj_01", "obj_02", ...
- confidence: 0..1.
- If the task implies an item that should be present but is absent (e.g. oil while frying),
  include it as an object with state "not detected" and raise an anomaly for it.
- anomalies[].type is one of "warning", "info", "danger". Use [] when nothing is wrong.
- explicitly_mentioned: object labels the user named in their transcript; [] if none.
- If "task" is not provided in context, infer it from the scene. Echo "mode" as given (default "observe").
- Salient objects only. Keep every string short.`;
app.post("/api/vision", async (req, res) => {
    try {
        const { image, tier, session_id, task_context, user_transcript, recent, media_meta, } = req.body;
        if (!image) {
            return res.status(400).json({ error: "image is required." });
        }
        const modelName = tier === "deep" ? VISION_MODEL_DEEP : VISION_MODEL_FAST;
        const ctxLine = `Context — task: ${task_context?.task || "infer it"}; mode: ${task_context?.mode || "observe"}; ` +
            `recent: ${(recent || []).filter(Boolean).join(" | ") || "none"}.`;
        const qLine = user_transcript && user_transcript.trim()
            ? `User transcript: "${user_transcript.trim()}". Note referenced objects in explicitly_mentioned.`
            : "No user transcript.";
        const prompt = [
            ctxLine,
            qLine,
            "Return only the JSON object from your instructions.",
        ].join("\n");
        const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
        const response = await visionAI.models.generateContent({
            model: modelName,
            contents: [
                {
                    role: "user",
                    parts: [
                        { text: prompt },
                        { inlineData: { mimeType: "image/jpeg", data: base64Data } },
                    ],
                },
            ],
            config: {
                systemInstruction: VISION_SYSTEM,
                responseMimeType: "application/json",
            },
        });
        const m = normalize(safeParse(response.text ?? ""));
        // Assemble the v1.0 envelope — model content + server-stamped metadata.
        res.json({
            schema_version: "1.0",
            input_type: "visual",
            session_id: session_id || null,
            timestamp: new Date().toISOString(),
            task_context: {
                task: task_context?.task || m.task_context.task || "unknown",
                mode: task_context?.mode || m.task_context.mode || "observe",
            },
            scene: m.scene,
            user_flags: {
                explicitly_mentioned: m.user_flags.explicitly_mentioned,
                user_transcript: user_transcript || "",
            },
            media_meta: media_meta || {
                source_type: "video_frame",
                frame_index: null,
                resolution: null,
                capture_device: "unknown",
            },
            model: modelName,
        });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("Vision error:", msg);
        res.status(500).json({ error: msg });
    }
});
// Best-effort parse of the model's JSON, tolerant of stray fences/prose.
function safeParse(raw) {
    const t = (s) => {
        try {
            return JSON.parse(s);
        }
        catch {
            return null;
        }
    };
    let o = t(raw) || t(raw.replace(/```json|```/g, "").trim());
    if (!o) {
        const match = raw.match(/\{[\s\S]*\}/);
        if (match)
            o = t(match[0]);
    }
    return o || { scene: { summary: raw.slice(0, 200) } };
}
// Guarantee every field the contract promises, so the client never breaks.
function normalize(o) {
    const s = o.scene || {};
    const clamp = (n) => typeof n === "number" ? Math.max(0, Math.min(1, n)) : 0.5;
    const objects = (Array.isArray(s.objects) ? s.objects : []).map((obj, i) => ({
        id: obj.id || `obj_${String(i + 1).padStart(2, "0")}`,
        label: obj.label || "unknown",
        state: obj.state || "",
        position: obj.position ?? null,
        confidence: clamp(obj.confidence),
    }));
    const anomalies = (Array.isArray(s.anomalies) ? s.anomalies : []).map((a) => ({
        type: ["warning", "info", "danger"].includes(a.type) ? a.type : "info",
        description: a.description || "",
    }));
    return {
        task_context: {
            task: o.task_context?.task || null,
            mode: o.task_context?.mode || null,
        },
        scene: {
            summary: s.summary || "",
            environment: s.environment || "unknown",
            objects,
            spatial_layout: {
                description: s.spatial_layout?.description || "",
                dimensions_available: !!s.spatial_layout?.dimensions_available,
            },
            anomalies,
        },
        user_flags: {
            explicitly_mentioned: Array.isArray(o.user_flags?.explicitly_mentioned)
                ? o.user_flags.explicitly_mentioned
                : [],
        },
    };
}
// --- start ------------------------------------------------------------------
app.listen(PORT, () => console.log(`DaVinci server up on http://localhost:${PORT}`));
//# sourceMappingURL=server.js.map