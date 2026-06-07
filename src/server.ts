/**
 * src/server.ts — the HTTP edge.
 *
 * Keeps the EXACT routes/shapes your existing website already speaks:
 *   POST /api/chat   { message, history } -> { reply }
 *   POST /api/vision { image, question }  -> { reply }
 *   static serving of public/
 *
 * Difference from the old server.js: /api/chat now flows through the
 * orchestrator (researcher/planner/executor routed by Gemini) instead of a
 * raw Gemini call. The website doesn't notice — same request, same { reply }.
 */

import "dotenv/config";
import express, { Request, Response } from "express";
import cors from "cors";
import path from "path";
import { GoogleGenAI } from "@google/genai";

import { AgentRequest, Context, CONTRACT_VERSION } from "./core/types";
import { AgentRegistry } from "./core/registry";
import { KeywordRouter, LlmRouter, Router } from "./core/router";
import { Orchestrator } from "./agents/orchestrator";
import { ResearcherAgent } from "./agents/researcher";
import { PlannerAgent } from "./agents/planner";
import { ExecutorAgent } from "./agents/executor";
import { GeminiProvider } from "./llm/gemini";
import { FileStore } from "./store/fileStore";

// --- config -----------------------------------------------------------------
const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const apiKey = process.env.GEMINI_API_KEY ?? process.env.API_KEY;

// --- wiring (built once at startup) -----------------------------------------
// The real researcher/planner need an LLM, so a key is now required.
if (!apiKey) {
    console.error(
        "[fatal] No API key found (set API_KEY or GEMINI_API_KEY in .env). " +
        "The researcher and planner agents require it."
    );
    process.exit(1);
}

const gemini = new GeminiProvider({ apiKey });
console.log(`[brain] Gemini active (${gemini.modelId})`);

const registry = new AgentRegistry();
registry.register(new ResearcherAgent(gemini)); // real
registry.register(new PlannerAgent(gemini)); // real
registry.register(new ExecutorAgent()); // dummy (no LLM needed yet)

// LlmRouter is the brain; KeywordRouter remains available as a fallback class.
const router: Router = new LlmRouter(gemini);
void KeywordRouter; // kept intentionally for future fallback wiring

const orchestrator = new Orchestrator(registry, router, { maxSteps: 4 });
const store = new FileStore();

// Raw Gemini client for the (interim) vision endpoint.
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
        // memory works even if the website sends nothing. We seed from stored
        // history; if the client also sends history and we have none stored yet,
        // we adopt the client's as a starting point.
        type StoredTurn = { role: "user" | "researcher" | "planner" | "executor" | "orchestrator"; message: string; at: string };
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
        // Persist the full conversation (trimmed) back into state, plus whatever
        // plan/state the agents updated.
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

// POST /api/vision -----------------------------------------------------------
// Interim: direct Gemini vision call (ported to @google/genai). This is the
// seam where the real vision pipeline will later feed the orchestrator as a
// SceneInput. Kept working so the website's camera feature doesn't break.
app.post("/api/vision", async (req: Request, res: Response) => {
    try {
        const { image, question } = req.body as {
            image?: string;
            question?: string;
        };
        if (!image) {
            return res.status(400).json({ error: "image is required." });
        }

        const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
        const prompt =
            question && question.trim()
                ? question.trim()
                : "Describe what you see in this image concisely. If there is text, read it. If there are objects, identify them.";

        const response = await visionAI.models.generateContent({
            model: "gemini-3.5-flash",
            contents: [
                {
                    role: "user",
                    parts: [
                        { text: prompt },
                        { inlineData: { mimeType: "image/jpeg", data: base64Data } },
                    ],
                },
            ],
        });

        res.json({ reply: response.text ?? "" });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("Vision error:", msg);
        res.status(500).json({ error: msg });
    }
});

// --- start ------------------------------------------------------------------
app.listen(PORT, () =>
    console.log(`DaVinci server up on http://localhost:${PORT}`)
);