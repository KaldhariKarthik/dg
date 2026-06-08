/**
 * src/server.ts — the HTTP edge. THE SINGLE SERVER ENTRYPOINT.
 *
 * Multi-user: every request's identity comes from a server-side session resolved
 * from an httpOnly cookie (attachUser middleware). No route trusts a client-sent
 * id. The old `"default"` / `session_id`-in-body / `sess_random` identities are
 * gone — everything keys off the authenticated `req.userId` (Google sub).
 *
 * Routes:
 *   GET  /api/auth/google           -> begin Google login (identity+Gmail+Cal)
 *   GET  /api/auth/google/callback  -> verify, upsert user, mint session
 *   POST /api/auth/logout           -> revoke session
 *   GET  /api/me                    -> current user + connected capabilities
 *   POST /api/chat        (auth)    -> { message } -> { reply }
 *   POST /api/vision      (auth)    -> { image, tier?, ... } -> v1.0 envelope
 *   POST /api/orchestrate (auth)    -> { observation } -> directive
 *   static public/
 */

import "dotenv/config";
import express, { Request, Response } from "express";
import cors from "cors";
import { randomBytes } from "crypto";
import { GoogleGenAI } from "@google/genai";
import { AgentRequest, Context, CONTRACT_VERSION } from "./core/types";
import { AgentRegistry } from "./core/registry";
import { KeywordRouter, LlmRouter, Router } from "./core/router";
import { Orchestrator } from "./agents/orchestrator";
import { ResearcherAgent } from "./agents/researcher";
import { PlannerAgent } from "./agents/planner";
import { ExecutorAgent } from "./agents/executor";
import { ConversationalAgent } from "./agents/conversational";
import { VisionAgent } from "./agents/vision";
import { GeminiProvider } from "./llm/gemini";
import { LastMessageSynthesizer, LlmSynthesizer, Synthesizer } from "./core/synthesizer";
import { GoogleAuth, NotConnectedError } from "./adapters/google-auth";
import { GoogleGmailAdapter } from "./adapters/gmail";
import { GoogleCalendarAdapter } from "./adapters/calendar";
import { GoogleLogin } from "./auth/googleOAuth";
import {
    makeAttachUser,
    requireAuth,
    setSessionCookie,
    clearSessionCookie,
    setOAuthStateCookie,
    clearOAuthStateCookie,
    readCookie,
    OAUTH_STATE_COOKIE,
    SESSION_COOKIE,
} from "./auth/middleware";
import { buildStores } from "./store/factory";

// --- config -----------------------------------------------------------------
const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const apiKey = process.env.GEMINI_API_KEY ?? process.env.API_KEY;

const VISION_MODEL_FAST = "gemini-3.1-flash-lite";
const VISION_MODEL_DEEP = "gemini-3.5-flash";

if (!apiKey) {
    console.error("[fatal] No API key (set API_KEY or GEMINI_API_KEY).");
    process.exit(1);
}

// Multi-user REQUIRES Google login, so Google OAuth must be configured.
const googleCfg = {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    redirectUri: process.env.GOOGLE_REDIRECT_URI ?? "",
};
if (!googleCfg.clientId || !googleCfg.clientSecret || !googleCfg.redirectUri) {
    console.error(
        "[fatal] Google OAuth not configured. Multi-user login needs " +
        "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI " +
        "(redirect URI must point to /api/auth/google/callback)."
    );
    process.exit(1);
}

// --- wiring (built once at startup) -----------------------------------------
const gemini = new GeminiProvider({ apiKey });
console.log(`[brain] Gemini active (${gemini.modelId})`);

const stores = buildStores();
const { users, sessions, working: store, memory: memoryStore } = stores;

const googleLogin = new GoogleLogin(googleCfg);
const googleApiAuth = new GoogleAuth(googleCfg, users);
console.log("[auth] Google OAuth configured.");

// Per-user adapter factories handed to the executor.
const gmailFactory = (userId: string) => new GoogleGmailAdapter(googleApiAuth, userId);
const calendarFactory = (userId: string) => new GoogleCalendarAdapter(googleApiAuth, userId);

const registry = new AgentRegistry();
registry.register(new ResearcherAgent(gemini));
registry.register(new PlannerAgent(gemini));
registry.register(new ConversationalAgent(gemini));
registry.register(new VisionAgent(gemini));
registry.register(new ExecutorAgent(gemini, gmailFactory, calendarFactory));

const router: Router = new LlmRouter(gemini);
void KeywordRouter;

const synth: Synthesizer = new LlmSynthesizer(gemini);
void LastMessageSynthesizer;

const orchestrator = new Orchestrator(registry, router, synth, gemini, memoryStore, { maxSteps: 4 });

const visionAI = new GoogleGenAI({ apiKey });

// --- app --------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(cors({ origin: true, credentials: true })); // same-origin app; credentials for cookies
app.use(makeAttachUser(sessions)); // populates req.userId from the session cookie
app.use(express.static("public"));

/* ============================ AUTH ROUTES ============================== */

// GET /api/auth/google — begin login. Sets an anti-CSRF state cookie and
// redirects to Google's consent screen (identity + Gmail + Calendar).
app.get("/api/auth/google", (_req: Request, res: Response) => {
    const state = randomBytes(16).toString("hex");
    setOAuthStateCookie(res, state);
    res.redirect(googleLogin.consentUrl(state));
});

// GET /api/auth/google/callback — verify, upsert user, mint session.
app.get("/api/auth/google/callback", async (req: Request, res: Response) => {
    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;
    const expected = readCookie(req, OAUTH_STATE_COOKIE);
    clearOAuthStateCookie(res);

    if (!code) return res.status(400).send("Missing authorization code.");
    if (!state || !expected || state !== expected) {
        return res.status(400).send("Invalid OAuth state. Please try signing in again.");
    }

    try {
        const verified = await googleLogin.handleCallback(code);
        await users.upsertUser({
            id: verified.userId,
            email: verified.email,
            displayName: verified.displayName,
        });
        // Only overwrite the stored credential if Google gave us a refresh
        // token (it does on first consent + prompt=consent). Otherwise merge so
        // we keep the existing one.
        if (verified.google.refresh_token) {
            await users.setGoogleCredential(verified.userId, verified.google);
        } else {
            await users.mergeGoogleTokens(verified.userId, verified.google);
        }

        const session = await sessions.create(verified.userId);
        setSessionCookie(res, session.id);
        res.redirect("/");
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("OAuth callback error:", msg);
        res.status(500).send("Failed to sign in with Google: " + msg);
    }
});

// POST /api/auth/logout — revoke this session.
app.post("/api/auth/logout", async (req: Request, res: Response) => {
    const sid = readCookie(req, SESSION_COOKIE);
    if (sid) await sessions.revoke(sid).catch(() => { });
    clearSessionCookie(res);
    res.json({ ok: true });
});

// GET /api/me — who am I, and what's connected.
app.get("/api/me", requireAuth, async (req: Request, res: Response) => {
    const user = await users.getUser(req.userId!);
    if (!user) return res.status(401).json({ error: "Not authenticated." });
    const scopes = user.google?.scopes ?? [];
    res.json({
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        connected: {
            google: Boolean(user.google?.refresh_token),
            gmail: scopes.includes("https://www.googleapis.com/auth/gmail.send"),
            calendar: scopes.includes("https://www.googleapis.com/auth/calendar"),
        },
    });
});

/* ============================ APP ROUTES ============================== */

// POST /api/chat -------------------------------------------------------------
app.post("/api/chat", requireAuth, async (req: Request, res: Response) => {
    try {
        const { message } = req.body as { message?: string };
        if (!message) return res.status(400).json({ error: "message is required." });

        const userId = req.userId!;
        const state = await store.load(userId);

        type StoredTurn = {
            role:
            | "user" | "researcher" | "planner" | "executor"
            | "conversational" | "vision" | "orchestrator";
            message: string;
            at: string;
        };
        const storedHistory: StoredTurn[] = Array.isArray(state.conversation)
            ? (state.conversation as StoredTurn[])
            : [];

        storedHistory.push({ role: "user", message, at: new Date().toISOString() });

        const ctx: Context = {
            userId,
            state,
            history: storedHistory,
            startedAt: new Date().toISOString(),
        };

        const agentReq: AgentRequest = {
            contractVersion: CONTRACT_VERSION,
            input: { kind: "text", text: message },
        };

        const result = await orchestrator.run(agentReq, ctx);

        ctx.state.conversation = ctx.history.slice(-40);
        await store.save(userId, ctx.state);

        res.json({ reply: result.message });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("Chat error:", msg);
        res.status(500).json({ error: msg });
    }
});

// POST /api/vision -----------------------------------------------------------
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

app.post("/api/vision", requireAuth, async (req: Request, res: Response) => {
    try {
        const {
            image, tier, task_context, user_transcript, recent, media_meta,
        } = req.body as {
            image?: string;
            tier?: string;
            task_context?: { task?: string; mode?: string };
            user_transcript?: string;
            recent?: string[];
            media_meta?: Record<string, unknown>;
        };
        if (!image) return res.status(400).json({ error: "image is required." });

        const modelName = tier === "deep" ? VISION_MODEL_DEEP : VISION_MODEL_FAST;

        const ctxLine =
            `Context — task: ${task_context?.task || "infer it"}; mode: ${task_context?.mode || "observe"}; ` +
            `recent: ${(recent || []).filter(Boolean).join(" | ") || "none"}.`;
        const qLine =
            user_transcript && user_transcript.trim()
                ? `User transcript: "${user_transcript.trim()}". Note referenced objects in explicitly_mentioned.`
                : "No user transcript.";
        const prompt = [ctxLine, qLine, "Return only the JSON object from your instructions."].join("\n");
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

        res.json({
            schema_version: "1.0",
            input_type: "visual",
            session_id: req.userId, // authenticated user, not a client-sent id
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

// POST /api/orchestrate ------------------------------------------------------
app.post("/api/orchestrate", requireAuth, async (req: Request, res: Response) => {
    try {
        const { observation } = req.body as { observation?: any };
        if (!observation) return res.status(400).json({ error: "observation is required." });

        const userId = req.userId!;
        const state = await store.load(userId);
        const transcript = observation?.user_flags?.user_transcript || undefined;

        const ctx: Context = {
            userId,
            state,
            history: [], // vision observations don't pollute the chat transcript
            startedAt: new Date().toISOString(),
        };

        const agentReq: AgentRequest = {
            contractVersion: CONTRACT_VERSION,
            input: { kind: "scene", scene: observation, text: transcript },
        };

        const result = await orchestrator.run(agentReq, ctx);
        await store.save(userId, ctx.state);

        const directive = ((result.data as any) || {}).result || {};
        res.json({
            guidance: result.message || "",
            watch_for: directive.watch_for ?? null,
            done: !!directive.done,
            done_message: directive.done_message || "",
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("Orchestrate error:", msg);
        res.status(500).json({ error: msg });
    }
});

// Best-effort parse of the model's JSON, tolerant of stray fences/prose.
function safeParse(raw: string): any {
    const t = (s: string) => {
        try { return JSON.parse(s); } catch { return null; }
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
    console.log(`DaVinci server up on http://localhost:${PORT} [store: ${stores.backend}]`)
);