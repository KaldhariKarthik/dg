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

import "dotenv/config";
import express, { Request, Response } from "express";
import cors from "cors";
import { GoogleGenAI } from "@google/genai";

import { AgentRequest, Context, CONTRACT_VERSION } from "./core/types";
import { AgentRegistry } from "./core/registry";
import { KeywordRouter, LlmRouter, Router } from "./core/router";
import { Orchestrator } from "./agents/orchestrator";
import { ResearcherAgent } from "./agents/researcher";
import { PlannerAgent } from "./agents/planner";
import { ExecutorAgent } from "./agents/executor";
import { ConversationalAgent } from "./agents/conversational";
import { GeminiProvider } from "./llm/gemini";
import { FileStore } from "./store/fileStore";
import { LastMessageSynthesizer, LlmSynthesizer, Synthesizer } from "./core/synthesizer";
import { GoogleAuth, NotConnectedError } from "./adapters/google-auth";
import { GoogleGmailAdapter } from "./adapters/gmail";
import { GoogleCalendarAdapter } from "./adapters/calendar";

// --- config -----------------------------------------------------------------
const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const apiKey = process.env.GEMINI_API_KEY ?? process.env.API_KEY;

// Vision model tiers. fast = high-frequency streaming path (cheap, low-latency);
// deep = explicit user questions / harder visual reasoning. The client picks
// the tier per frame via `tier: "fast" | "deep"`.
const VISION_MODEL_FAST = "gemini-3.1-flash-lite";
const VISION_MODEL_DEEP = "gemini-3.5-flash";

if (!apiKey) {
    console.error(
        "[fatal] No API key found (set API_KEY or GEMINI_API_KEY in .env). " +
        "The researcher and planner agents require it."
    );
    process.exit(1);
}

// --- wiring (built once at startup) -----------------------------------------
const gemini = new GeminiProvider({ apiKey });
console.log(`[brain] Gemini active (${gemini.modelId})`);

const store = new FileStore();

// Google OAuth — shared by Gmail today and Calendar later. Optional at boot:
// if the Google env vars aren't set, the executor still loads and will simply
// tell the user to connect Google when they try to send.
const googleConfigured = Boolean(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REDIRECT_URI
);
const googleAuth = googleConfigured
    ? new GoogleAuth(
        {
            clientId: process.env.GOOGLE_CLIENT_ID as string,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
            redirectUri: process.env.GOOGLE_REDIRECT_URI as string,
        },
        store
    )
    : null;
if (googleConfigured) {
    console.log("[auth] Google OAuth configured.");
} else {
    console.warn(
        "[auth] Google OAuth NOT configured (set GOOGLE_CLIENT_ID, " +
        "GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI). Email sending will be " +
        "disabled until connected."
    );
}

// Per-session Gmail adapter factory handed to the executor. If Google isn't
// configured, the factory still returns an adapter whose send() throws
// NotConnectedError — which the executor turns into a friendly "connect" reply.
const gmailFactory = (sessionId: string) => {
    if (!googleAuth) {
        return {
            async send(): Promise<never> {
                throw new NotConnectedError(sessionId);
            },
        };
    }
    return new GoogleGmailAdapter(googleAuth, sessionId);
};

// Per-session Calendar adapter factory (reuses the same Google auth).
const calendarFactory = (sessionId: string) => {
    if (!googleAuth) {
        return {
            async createEvent(): Promise<never> {
                throw new NotConnectedError(sessionId);
            },
            async updateEvent(): Promise<never> {
                throw new NotConnectedError(sessionId);
            },
        };
    }
    return new GoogleCalendarAdapter(googleAuth, sessionId);
};

const registry = new AgentRegistry();
registry.register(new ResearcherAgent(gemini)); // real
registry.register(new PlannerAgent(gemini)); // real
registry.register(new ExecutorAgent()); // dummy (no LLM needed yet)
registry.register(new ConversationalAgent(gemini)); // real
registry.register(new ExecutorAgent(gemini, gmailFactory, calendarFactory)); // real (Gmail + Calendar)

// LlmRouter is the brain; KeywordRouter stays available as a fallback class.
const router: Router = new LlmRouter(gemini);
void KeywordRouter; // kept intentionally for future fallback wiring

// LlmSynthesizer fuses multi-agent turns into one DaVinci voice;
// LastMessageSynthesizer stays available as the no-key / test fallback.
const synth: Synthesizer = new LlmSynthesizer(gemini);
void LastMessageSynthesizer;

const orchestrator = new Orchestrator(registry, router, synth, { maxSteps: 8 });
const store = new FileStore();
const orchestrator = new Orchestrator(registry, router, { maxSteps: 4 });

// Raw Gemini client for the perception endpoint.
const visionAI = new GoogleGenAI({ apiKey });

// --- app --------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(cors()); // permissive for dev; tighten when deployment is known
app.use(express.static("public"));

// POST /api/chat -------------------------------------------------------------
app.post("/api/chat", async (req: Request, res: Response) => {
    try {
        const { message, sessionId, history } = req.body as {
            message?: string;
            sessionId?: string;
            history?: Array<{ role?: string; parts?: Array<{ text?: string }> }>;
        };
        if (!message) {
            return res.status(400).json({ error: "message is required." });
        }

        const sid = sessionId ?? "default";

        // Load durable server-side state (plans + conversation) for this session.
        const state = await store.load(sid);

        // Conversation history is OWNED BY THE SERVER (stored per session), so
        // memory works even if the website sends nothing. Seed from stored
        // history; if the client sends history and we have none stored yet,
        // adopt the client's as a starting point.
        type StoredTurn = {
            role: "user" | "researcher" | "planner" | "executor" | "orchestrator";
            message: string;
            at: string;
        };
        let storedHistory: StoredTurn[] = Array.isArray(state.conversation)
            ? (state.conversation as StoredTurn[])
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

        const ctx: Context = {
            sessionId: sid,
            state,
            history: storedHistory,
            startedAt: new Date().toISOString(),
        };

        const agentReq: AgentRequest = {
            contractVersion: CONTRACT_VERSION,
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
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("Chat error:", msg);
        res.status(500).json({ error: msg });
    }
});

// GET /api/auth/google ------------------------------------------------------
// Kick off the OAuth consent flow. Pass ?sessionId=... to link a specific
// session (defaults to "default", matching /api/chat).
app.get("/api/auth/google", (req: Request, res: Response) => {
    if (!googleAuth) {
        return res
            .status(503)
            .send("Google OAuth is not configured on the server.");
    }
    const sessionId = (req.query.sessionId as string) || "default";
    res.redirect(googleAuth.consentUrl(sessionId));
});

// GET /api/auth/google/callback ---------------------------------------------
// Google redirects here with ?code=...&state=<sessionId>. Exchange + store.
app.get("/api/auth/google/callback", async (req: Request, res: Response) => {
    if (!googleAuth) {
        return res.status(503).send("Google OAuth is not configured.");
    }
    const code = req.query.code as string | undefined;
    const sessionId = (req.query.state as string) || "default";
    if (!code) {
        return res.status(400).send("Missing authorization code.");
    }
    try {
        await googleAuth.handleCallback(sessionId, code);
        res.send(
            "<h2>Google connected ✅</h2><p>You can close this tab and return " +
            "to the chat. Try: \"send an email to someone@example.com\".</p>"
        );
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("OAuth callback error:", msg);
        res.status(500).send("Failed to connect Google: " + msg);
    }
});

// GET /api/auth/google/status ------------------------------------------------
app.get("/api/auth/google/status", async (req: Request, res: Response) => {
    const sessionId = (req.query.sessionId as string) || "default";
    const connected = googleAuth
        ? await googleAuth.isConnected(sessionId)
        : false;
    res.json({ connected });
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

app.post("/api/vision", async (req: Request, res: Response) => {
    try {
        const {
            image,
            tier,
            session_id,
            task_context,
            user_transcript,
            recent,
            media_meta,
        } = req.body as {
            image?: string;
            tier?: string;
            session_id?: string;
            task_context?: { task?: string; mode?: string };
            user_transcript?: string;
            recent?: string[];
            media_meta?: Record<string, unknown>;
        };
        if (!image) {
            return res.status(400).json({ error: "image is required." });
        }

        const modelName = tier === "deep" ? VISION_MODEL_DEEP : VISION_MODEL_FAST;

        const ctxLine =
            `Context — task: ${task_context?.task || "infer it"}; mode: ${task_context?.mode || "observe"}; ` +
            `recent: ${(recent || []).filter(Boolean).join(" | ") || "none"}.`;
        const qLine =
            user_transcript && user_transcript.trim()
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
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("Vision error:", msg);
        res.status(500).json({ error: msg });
    }
});

// Best-effort parse of the model's JSON, tolerant of stray fences/prose.
function safeParse(raw: string): any {
    const t = (s: string) => {
        try {
            return JSON.parse(s);
        } catch {
            return null;
        }
    };
    let o = t(raw) || t(raw.replace(/```json|```/g, "").trim());
    if (!o) {
        const match = raw.match(/\{[\s\S]*\}/);
        if (match) o = t(match[0]);
    }
    return o || { scene: { summary: raw.slice(0, 200) } };
}

// Guarantee every field the contract promises, so the client never breaks.
function normalize(o: any) {
    const s = o.scene || {};
    const clamp = (n: unknown) =>
        typeof n === "number" ? Math.max(0, Math.min(1, n)) : 0.5;
    const objects = (Array.isArray(s.objects) ? s.objects : []).map(
        (obj: any, i: number) => ({
            id: obj.id || `obj_${String(i + 1).padStart(2, "0")}`,
            label: obj.label || "unknown",
            state: obj.state || "",
            position: obj.position ?? null,
            confidence: clamp(obj.confidence),
        })
    );
    const anomalies = (Array.isArray(s.anomalies) ? s.anomalies : []).map(
        (a: any) => ({
            type: ["warning", "info", "danger"].includes(a.type) ? a.type : "info",
            description: a.description || "",
        })
    );
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
app.listen(PORT, () =>
    console.log(`DaVinci server up on http://localhost:${PORT}`)
);