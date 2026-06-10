"use strict";
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
 *   POST /api/chat        (auth)    -> { message } -> { reply, offer? }
 *   POST /api/vision      (auth)    -> { image, tier?, ... } -> v1.0 envelope
 *   POST /api/orchestrate (auth)    -> { observation } -> directive (+ step_checked)
 *   POST /api/vision/session/end (auth) -> { planId, summaries } -> { recap }
 *   POST /api/recall/sync (auth)    -> index the user's Drive
 *   GET  /api/recall/search (auth)  -> { q } -> ranked hits
 *   GET  /api/recall/status (auth)  -> { docs, chunks }
 *   static public/
 *
 * Stability fixes folded in here:
 *   Fix 3 — per-user rate limits on /api/vision and /api/orchestrate (the model
 *           endpoints the untrusted client polls).
 *   Fix 4 — CORS pinned to a configured origin instead of reflecting any origin
 *           with credentials.
 *   Fix 5 — the "guide me with the camera" offer is now actually emitted from
 *           /api/chat when a hands-on plan is created/updated (isPhysicalTask was
 *           dead code; the frontend already listens for `offer.planId`).
 *   Fix 6 — the direct vision generateContent call is wrapped in withTimeout (the
 *           rest of the model calls go through GeminiProvider, already wrapped).
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const crypto_1 = require("crypto");
const genai_1 = require("@google/genai");
const types_1 = require("./core/types");
const registry_1 = require("./core/registry");
const router_1 = require("./core/router");
const orchestrator_1 = require("./agents/orchestrator");
const researcher_1 = require("./agents/researcher");
const planner_1 = require("./agents/planner");
const executor_1 = require("./agents/executor");
const conversational_1 = require("./agents/conversational");
const vision_1 = require("./agents/vision");
const gemini_1 = require("./llm/gemini");
const synthesizer_1 = require("./core/synthesizer");
const google_auth_1 = require("./adapters/google-auth");
const gmail_1 = require("./adapters/gmail");
const calendar_1 = require("./adapters/calendar");
const googleOAuth_1 = require("./auth/googleOAuth");
const middleware_1 = require("./auth/middleware");
const factory_1 = require("./store/factory");
const planStore_1 = require("./store/planStore");
const rateLimit_1 = require("./middleware/rateLimit");
const withTimeout_1 = require("./util/withTimeout");
const http_1 = require("http");
const liveServer_1 = require("./live/liveServer");
const drive_1 = require("./adapters/drive");
const embeddings_1 = require("./recall/embeddings");
const recall_1 = require("./recall/recall");
const routes_1 = require("./recall/routes");
const proactive_1 = require("./proactive/proactive");
const routes_2 = require("./proactive/routes");
// --- config -----------------------------------------------------------------
const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const apiKey = (process.env.GEMINI_API_KEY ?? process.env.API_KEY ?? "").trim();
const cronKey = (process.env.CRON_KEY ?? "").trim();
const VISION_MODEL_FAST = "gemini-3.1-flash-lite";
const VISION_MODEL_DEEP = "gemini-3.5-flash";
const VISION_TIMEOUT_MS = 25_000;
const LIVE_MODEL = (process.env.LIVE_MODEL ?? "gemini-3.1-flash-live-preview").trim();
// Warm female voice. Swap via LIVE_VOICE; nice alts: Leda, Kore, Sulafat, Callirrhoe, Achernar.
const LIVE_VOICE = (process.env.LIVE_VOICE ?? "Aoede").trim();
const LIVE_SYSTEM = "You are DaVinci — a calm, warm, concise personal assistant speaking out loud " +
    "and, when the camera is on, seeing what the user sees. Keep spoken replies " +
    "short and natural, like a person beside them. Never mention that you are an " +
    "AI, or talk about cameras, frames, audio, or tools.\n\n" +
    "You can act using tools: read and update the user's plans, check steps off, " +
    "recall and remember things about them, and draft/send email and calendar " +
    "events. CONFIRMATION IS MANDATORY for anything that touches the outside world: " +
    "for email, always compose_email first, read the draft aloud, and ask the user " +
    "to confirm; only call send_email after they clearly agree. For calendar, " +
    "always propose_event first and confirm before create_event. Never send or " +
    "create without a spoken yes. If they're working with their hands, guide one " +
    "step at a time and check_step off only when you can see it's genuinely done." +
    "When planning time-bound work or before agreeing to a commitment, check the " +
    "user's real calendar with list_events or find_free_time first. Fit work into " +
    "the hours that actually exist, and warn them plainly when something conflicts " +
    "or a new commitment would jeopardize a deadline — name the specific clash. " +
    "When the user asks about something they wrote, saved, or decided, or refers to " +
    "a note, doc, or file of theirs, call search_documents to find it before " +
    "answering, and name the document you drew from.";
// Fix 4: the app is served same-origin (express.static below), so cross-origin
// requests are not needed for normal use. Default to no cross-origin access;
// set APP_ORIGIN to explicitly allow one origin (e.g. a separate front-end host).
const appOrigin = (process.env.APP_ORIGIN ?? "").trim();
if (!apiKey) {
    console.error("[fatal] No API key (set API_KEY or GEMINI_API_KEY).");
    process.exit(1);
}
// Multi-user REQUIRES Google login, so Google OAuth must be configured.
const googleCfg = {
    clientId: (process.env.GOOGLE_CLIENT_ID ?? "").trim(),
    clientSecret: (process.env.GOOGLE_CLIENT_SECRET ?? "").trim(),
    redirectUri: (process.env.GOOGLE_REDIRECT_URI ?? "").trim(),
};
if (!googleCfg.clientId || !googleCfg.clientSecret || !googleCfg.redirectUri) {
    console.error("[fatal] Google OAuth not configured. Multi-user login needs " +
        "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI " +
        "(redirect URI must point to /api/auth/google/callback).");
    process.exit(1);
}
// --- wiring (built once at startup) -----------------------------------------
const gemini = new gemini_1.GeminiProvider({ apiKey });
console.log(`[brain] Gemini active (${gemini.modelId})`);
const stores = (0, factory_1.buildStores)();
const { users, sessions, working: store, memory: memoryStore, plans } = stores;
const googleLogin = new googleOAuth_1.GoogleLogin(googleCfg);
const googleApiAuth = new google_auth_1.GoogleAuth(googleCfg, users);
console.log("[auth] Google OAuth configured.");
// Per-user adapter factories handed to the executor.
const gmailFactory = (userId) => new gmail_1.GoogleGmailAdapter(googleApiAuth, userId);
const calendarFactory = (userId) => new calendar_1.GoogleCalendarAdapter(googleApiAuth, userId);
// Recall: read-only Drive adapter + embeddings + semantic search over the
// user's documents. driveFactory mirrors the gmail/calendar factory shape.
const driveFactory = (userId) => new drive_1.GoogleDriveAdapter(googleApiAuth, userId);
const embedder = new embeddings_1.Embedder(apiKey);
const recall = new recall_1.RecallService(stores.documents, embedder, driveFactory);
const proactive = new proactive_1.ProactiveService(stores.notifications, plans, memoryStore, calendarFactory, gemini);
const registry = new registry_1.AgentRegistry();
registry.register(new researcher_1.ResearcherAgent(gemini));
registry.register(new planner_1.PlannerAgent(gemini));
registry.register(new conversational_1.ConversationalAgent(gemini));
registry.register(new vision_1.VisionAgent(gemini));
registry.register(new executor_1.ExecutorAgent(gemini, gmailFactory, calendarFactory));
const router = new router_1.LlmRouter(gemini);
void router_1.KeywordRouter;
const synth = new synthesizer_1.LlmSynthesizer(gemini);
void synthesizer_1.LastMessageSynthesizer;
const orchestrator = new orchestrator_1.Orchestrator(registry, router, synth, gemini, memoryStore, { maxSteps: 4 });
const visionAI = new genai_1.GoogleGenAI({ apiKey });
// Fix 3: per-user limiters for the model-backed vision endpoints. Generous
// enough not to break a legitimately fast scene (the client only SENDS on a
// changed frame), tight enough to bound a runaway/abusive client's spend.
// Tunable via env. Each endpoint gets its own budget since they're called ~1:1.
const VISION_RATE_MAX = Number(process.env.VISION_RATE_MAX ?? 120);
const visionLimit = (0, rateLimit_1.rateLimitPerUser)({ max: VISION_RATE_MAX, windowMs: 60_000, name: "vision" });
const orchestrateLimit = (0, rateLimit_1.rateLimitPerUser)({ max: VISION_RATE_MAX, windowMs: 60_000, name: "vision" });
// --- app --------------------------------------------------------------------
const app = (0, express_1.default)();
app.use(express_1.default.json({ limit: "10mb" }));
// Fix 4: pin CORS. With a same-origin front-end no cross-origin access is needed,
// so the default is to allow none; APP_ORIGIN opens exactly one origin.
app.use((0, cors_1.default)({
    origin: appOrigin || false,
    credentials: true,
}));
app.use((0, middleware_1.makeAttachUser)(sessions)); // populates req.userId from the session cookie
app.use(express_1.default.static("public"));
// Recall REST surface (sync / search / status). Mounted here, where `app`,
// `requireAuth`, and `recall` all exist. getUserId mirrors how the other
// protected routes read identity (req.userId, set by attachUser).
(0, routes_1.mountRecallRoutes)(app, middleware_1.requireAuth, recall, (req) => req.userId ?? null);
(0, routes_2.mountProactiveRoutes)(app, middleware_1.requireAuth, proactive, stores.notifications, (req) => req.userId ?? null, cronKey);
/* ============================ AUTH ROUTES ============================== */
// GET /api/auth/google — begin login. Sets an anti-CSRF state cookie and
// redirects to Google's consent screen (identity + Gmail + Calendar + Drive).
app.get("/api/auth/google", (_req, res) => {
    const state = (0, crypto_1.randomBytes)(16).toString("hex");
    (0, middleware_1.setOAuthStateCookie)(res, state);
    res.redirect(googleLogin.consentUrl(state));
});
// GET /api/auth/google/callback — verify, upsert user, mint session.
app.get("/api/auth/google/callback", async (req, res) => {
    const code = req.query.code;
    const state = req.query.state;
    const expected = (0, middleware_1.readCookie)(req, middleware_1.OAUTH_STATE_COOKIE);
    (0, middleware_1.clearOAuthStateCookie)(res);
    if (!code)
        return res.status(400).send("Missing authorization code.");
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
        }
        else {
            await users.mergeGoogleTokens(verified.userId, verified.google);
        }
        const session = await sessions.create(verified.userId);
        (0, middleware_1.setSessionCookie)(res, session.id);
        res.redirect("/");
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("OAuth callback error:", msg);
        res.status(500).send("Failed to sign in with Google: " + msg);
    }
});
// POST /api/auth/logout — revoke this session.
app.post("/api/auth/logout", async (req, res) => {
    const sid = (0, middleware_1.readCookie)(req, middleware_1.SESSION_COOKIE);
    if (sid)
        await sessions.revoke(sid).catch(() => { });
    (0, middleware_1.clearSessionCookie)(res);
    res.json({ ok: true });
});
// GET /api/me — who am I, and what's connected.
app.get("/api/me", middleware_1.requireAuth, async (req, res) => {
    const user = await users.getUser(req.userId);
    if (!user)
        return res.status(401).json({ error: "Not authenticated." });
    const scopes = user.google?.scopes ?? [];
    res.json({
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        connected: {
            google: Boolean(user.google?.refresh_token),
            gmail: scopes.includes("https://www.googleapis.com/auth/gmail.send"),
            calendar: scopes.includes("https://www.googleapis.com/auth/calendar"),
            drive: scopes.includes("https://www.googleapis.com/auth/drive.readonly"),
        },
    });
});
// GET /api/memory — the current user's long-term memory profile.
app.get("/api/memory", middleware_1.requireAuth, async (req, res) => {
    try {
        const mem = await memoryStore.loadMemory(req.userId);
        res.json(mem);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("Memory error:", msg);
        res.status(500).json({ error: msg });
    }
});
/* ============================ APP ROUTES ============================== */
/**
 * If the planner proposed a plan this turn (stateDelta.planUpsert), upsert it
 * into the PlanStore — the SERVER owns id + timestamps via normalizePlan, so a
 * fumbled generation can't drift an id or erase createdAt. Then strip plan keys
 * from the working bag: plans live only in the PlanStore, never the bag.
 *
 * Returns the committed plan id (or null on a report-only turn) so the caller
 * can decide whether to offer a camera-guided session for it.
 */
async function commitPlanUpsert(ctx, userId) {
    const proposed = ctx.state.planUpsert;
    let committedId = null;
    if (proposed && typeof proposed === "object") {
        const existing = proposed.id ? await plans.getPlan(userId, proposed.id) : null;
        const normalized = (0, planStore_1.normalizePlan)(proposed, existing);
        await plans.upsertPlan(userId, normalized);
        committedId = normalized.id;
    }
    delete ctx.state.planUpsert;
    delete ctx.state.plans;
    delete ctx.state.sessionMode;
    delete ctx.state.activePlan;
    return committedId;
}
function isPhysicalTask(plan) {
    const text = [plan.goal ?? "", ...(Array.isArray(plan.steps) ? plan.steps.map((s) => s.text) : [])]
        .join(" ").toLowerCase();
    return /\b(cook|bake|fry|grill|roast|knead|chop|brew|make|prepare|assemble|build|install|mount|fix|repair|replace|wire|paint|sand|drill|screw|glue|sew|knit|fold|plant|pot|repot|water|clean|wash|set ?up|craft|draw|sketch|wrap|tie)\b/.test(text);
}
// GET /api/plans — the current user's live plans (most-recently-updated first).
app.get("/api/plans", middleware_1.requireAuth, async (req, res) => {
    try {
        res.json({ plans: await plans.listPlans(req.userId) });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("Plans error:", msg);
        res.status(500).json({ error: msg });
    }
});
// POST /api/plans/step — check a step on/off. Atomic per-plan on Firestore.
app.post("/api/plans/step", middleware_1.requireAuth, async (req, res) => {
    try {
        const { planId, stepIndex, done } = req.body;
        if (!planId || typeof stepIndex !== "number") {
            return res.status(400).json({ error: "planId and numeric stepIndex are required." });
        }
        const updated = await plans.setStepDone(req.userId, planId, stepIndex, Boolean(done));
        if (!updated)
            return res.status(404).json({ error: "Plan not found." });
        res.json({ plan: updated });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("Plan step error:", msg);
        res.status(500).json({ error: msg });
    }
});
// DELETE /api/plans/:id — remove a plan the user no longer wants.
app.delete("/api/plans/:id", middleware_1.requireAuth, async (req, res) => {
    try {
        await plans.deletePlan(req.userId, String(req.params.id));
        res.json({ ok: true });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("Plan delete error:", msg);
        res.status(500).json({ error: msg });
    }
});
// POST /api/chat -------------------------------------------------------------
app.post("/api/chat", middleware_1.requireAuth, async (req, res) => {
    try {
        const { message } = req.body;
        if (!message)
            return res.status(400).json({ error: "message is required." });
        const userId = req.userId;
        const state = await store.load(userId);
        // Plans live in their OWN store, not the working bag. Inject the current
        // set for the planner to read this turn; stripped again before save.
        state.plans = await plans.listPlans(userId);
        const storedHistory = Array.isArray(state.conversation)
            ? state.conversation
            : [];
        storedHistory.push({ role: "user", message, at: new Date().toISOString() });
        const ctx = {
            userId,
            state,
            history: storedHistory,
            startedAt: new Date().toISOString(),
        };
        const agentReq = {
            contractVersion: types_1.CONTRACT_VERSION,
            input: { kind: "text", text: message },
        };
        const result = await orchestrator.run(agentReq, ctx);
        const committedPlanId = await commitPlanUpsert(ctx, userId);
        ctx.state.conversation = ctx.history.slice(-40);
        await store.save(userId, ctx.state);
        // Fix 5: if we just created/updated a hands-on, physical plan, offer to
        // guide it with the camera (the planning -> vision bridge). The frontend
        // listens for `offer.planId` and renders a "guide me with the camera"
        // chip. committedPlanId is null on report-only turns, so the offer only
        // fires when a plan was actually written.
        let offer;
        if (committedPlanId) {
            try {
                const plan = await plans.getPlan(userId, committedPlanId);
                if (plan && isPhysicalTask(plan)) {
                    offer = {
                        planId: plan.id,
                        prompt: `Want me to guide you through "${plan.goal}" with the camera?`,
                    };
                }
            }
            catch (e) {
                console.error("[chat] offer check failed:", e);
            }
        }
        res.json({ reply: result.message, ...(offer ? { offer } : {}) });
    }
    catch (err) {
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
app.post("/api/vision", middleware_1.requireAuth, visionLimit, async (req, res) => {
    try {
        const { image, tier, task_context, user_transcript, recent, media_meta, } = req.body;
        if (!image)
            return res.status(400).json({ error: "image is required." });
        const modelName = tier === "deep" ? VISION_MODEL_DEEP : VISION_MODEL_FAST;
        const ctxLine = `Context — task: ${task_context?.task || "infer it"}; mode: ${task_context?.mode || "observe"}; ` +
            `recent: ${(recent || []).filter(Boolean).join(" | ") || "none"}.`;
        const qLine = user_transcript && user_transcript.trim()
            ? `User transcript: "${user_transcript.trim()}". Note referenced objects in explicitly_mentioned.`
            : "No user transcript.";
        const prompt = [ctxLine, qLine, "Return only the JSON object from your instructions."].join("\n");
        const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
        // Fix 6: hard timeout on the direct vision model call.
        const response = await (0, withTimeout_1.withTimeout)(visionAI.models.generateContent({
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
        }), VISION_TIMEOUT_MS, `vision ${modelName}`);
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
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("Vision error:", msg);
        res.status(500).json({ error: msg });
    }
});
// POST /api/orchestrate ------------------------------------------------------
app.post("/api/orchestrate", middleware_1.requireAuth, orchestrateLimit, async (req, res) => {
    try {
        const { observation, session } = req.body;
        if (!observation)
            return res.status(400).json({ error: "observation is required." });
        const userId = req.userId;
        const state = await store.load(userId);
        state.plans = await plans.listPlans(userId);
        // Guided session: bind the active plan so the vision agent reasons against
        // it. Injected into ctx.state like plans; stripped after the turn by
        // commitPlanUpsert. A plain "describe" session injects nothing.
        if (session?.mode === "guided") {
            state.sessionMode = "guided";
            if (session.planId) {
                const active = state.plans.find((p) => p.id === session.planId);
                if (active)
                    state.activePlan = active;
            }
        }
        const transcript = observation?.user_flags?.user_transcript || undefined;
        const ctx = {
            userId,
            state,
            history: [], // vision observations don't pollute the chat transcript
            startedAt: new Date().toISOString(),
        };
        const agentReq = {
            contractVersion: types_1.CONTRACT_VERSION,
            input: { kind: "scene", scene: observation, text: transcript },
        };
        const result = await orchestrator.run(agentReq, ctx);
        await commitPlanUpsert(ctx, userId);
        await store.save(userId, ctx.state);
        const directive = (result.data || {}).result || {};
        // FIX: actually perform the guided step check-off the vision agent decided
        // on. The agent only ever returns a validated, not-yet-done step index
        // (see VisionAgent.validateStepAction), but the write itself is the
        // server's job — plans live in their own store. We perform it here and
        // tell the client which index changed via `step_checked`, which is the
        // field public/index.html's orchestrate callback already listens for.
        // Without this, the headline "DaVinci checks steps off as it watches"
        // silently did nothing.
        let stepChecked = null;
        if (session?.mode === "guided" &&
            session.planId &&
            typeof directive.step_action === "number") {
            try {
                const updated = await plans.setStepDone(userId, session.planId, directive.step_action, true);
                if (updated)
                    stepChecked = directive.step_action;
            }
            catch (e) {
                console.error("[orchestrate] step check-off failed:", e);
            }
        }
        res.json({
            guidance: result.message || "",
            watch_for: directive.watch_for ?? null,
            done: !!directive.done,
            done_message: directive.done_message || "",
            step_checked: stepChecked,
        });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("Orchestrate error:", msg);
        res.status(500).json({ error: msg });
    }
});
// POST /api/vision/session/end -----------------------------------------------
// FIX: this route did not exist — public/index.html's onSessionEnd has always
// POSTed here when a guided session ends, so the call 404'd and the spoken
// recap never happened. It takes the scene log the client accrued during the
// session and returns ONE warm spoken-style recap line. (Persisting the session
// as reviewable "field notes" and extracting durable memory from it are separate
// follow-ups, intentionally not done here.)
app.post("/api/vision/session/end", middleware_1.requireAuth, async (req, res) => {
    try {
        const { planId, summaries } = req.body;
        const userId = req.userId;
        const log = Array.isArray(summaries)
            ? summaries.filter((s) => typeof s === "string" && s.trim().length > 0)
            : [];
        // Nothing observed — nothing to recap. Honest empty result.
        if (log.length === 0)
            return res.json({ recap: "" });
        let plan = null;
        if (planId) {
            try {
                plan = await plans.getPlan(userId, planId);
            }
            catch {
                plan = null;
            }
        }
        const planLine = plan
            ? `The user was being guided hands-on through: "${plan.goal}".`
            : "The user just finished a guided camera session.";
        const recapSystem = "You are DaVinci, wrapping up a hands-on guided session you just walked " +
            "the user through. You are given a time-ordered log of what the camera " +
            "saw. Write ONE warm, natural spoken sentence (two at most) recapping " +
            "what they got done — like a person who was standing beside them. No " +
            "lists, no markdown, and never mention cameras, logs, frames, or that " +
            "you are an assistant.";
        const recapUser = `${planLine}\n\nWhat was seen, in order:\n` +
            `${log.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\n` +
            "Write the recap now.";
        let recap = "";
        try {
            recap = (await gemini.complete([
                { role: "system", content: recapSystem },
                { role: "user", content: recapUser },
            ], { temperature: 0.5 })).trim();
        }
        catch (e) {
            console.error("[session/end] recap generation failed:", e);
            // Non-fatal: return an empty recap rather than erroring the client.
        }
        res.json({ recap });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("Session end error:", msg);
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
const httpServer = (0, http_1.createServer)(app);
(0, liveServer_1.attachLiveServer)(httpServer, sessions, {
    apiKey,
    model: LIVE_MODEL,
    voice: LIVE_VOICE,
    systemInstruction: LIVE_SYSTEM,
    deps: { plans, memory: memoryStore, gmailFactory, calendarFactory, recall },
});
httpServer.listen(PORT, () => console.log(`DaVinci server up on http://localhost:${PORT} ` +
    `[store: ${stores.backend}] [live: ${LIVE_MODEL} / ${LIVE_VOICE}]`));
//# sourceMappingURL=server.js.map