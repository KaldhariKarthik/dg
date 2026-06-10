/**
 * src/live/liveSession.ts — bridges ONE browser WebSocket to ONE Gemini Live
 * session, with the TOOL BRIDGE. Tools run server-side against the existing
 * stores/adapters (LiveToolRunner) and their results go back via sendToolResponse
 * (the Live API does NOT auto-handle tool responses). At connect we load the
 * user's plans + memory into the system instruction so she walks in knowing them.
 */
import type { WebSocket as WSSocket } from "ws";
import { GoogleGenAI, Modality } from "@google/genai";
import { LiveToolDeps, LiveToolRunner, TOOL_DECLARATIONS } from "./tools";

export interface LiveSessionConfig {
    apiKey: string;
    model: string;
    voice: string;
    systemInstruction: string;
    deps: LiveToolDeps;
}

export class LiveSession {
    private ai: GoogleGenAI;
    private session: any | null = null;
    private closed = false;
    private tools: LiveToolRunner;

    constructor(private clientWs: WSSocket, private userId: string, private cfg: LiveSessionConfig) {
        this.ai = new GoogleGenAI({ apiKey: cfg.apiKey });
        this.tools = new LiveToolRunner(userId, cfg.deps, (event, data) =>
            this.toClient({ type: "tool_event", event, data })
        );
    }

    async start(): Promise<void> {
        let contextBlock = "";
        try { contextBlock = await this.buildContext(); }
        catch (e) { console.error("[live] context load failed:", e); }

        try {
            this.session = await this.ai.live.connect({
                model: this.cfg.model,
                config: {
                    responseModalities: [Modality.AUDIO], // do NOT add TEXT — it breaks transcription
                    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.cfg.voice } } },
                    inputAudioTranscription: {},
                    outputAudioTranscription: {},
                    systemInstruction: this.cfg.systemInstruction + contextBlock,
                    tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
                },
                callbacks: {
                    onopen: () => this.toClient({ type: "ready" }),
                    onmessage: (m: any) => this.onModelMessage(m),
                    onerror: (e: any) => this.toClient({ type: "error", message: e?.message || "live error" }),
                    onclose: () => this.toClient({ type: "closed" }),
                },
            });
        } catch (err) {
            console.error("[live] connect failed:", err instanceof Error ? err.message : err);
            this.toClient({ type: "error", message: "Could not open the live session." });
            this.close();
            return;
        }
        this.clientWs.on("message", (raw) => this.onClientMessage(raw));
        this.clientWs.on("close", () => this.close());
        this.clientWs.on("error", () => this.close());
    }

    private async buildContext(): Promise<string> {
        const [plans, mem] = await Promise.all([
            this.cfg.deps.plans.listPlans(this.userId),
            this.cfg.deps.memory.loadMemory(this.userId),
        ]);
        const planLines = plans.slice(0, 8).map((p) => {
            const done = p.steps.filter((s) => s.done).length;
            return `- "${p.goal}" (id: ${p.id}, ${done}/${p.steps.length} done)`;
        }).join("\n") || "(none yet)";
        const prefs = Object.entries(mem.preferences).map(([k, v]) => `${k}: ${v}`).join("; ") || "none";
        return (
            "\n\nWhat you already know about this user (use naturally, don't recite):\n" +
            `Plans:\n${planLines}\n` +
            `Preferences: ${prefs}\n` +
            `Patterns: ${mem.past_patterns.join("; ") || "none"}\n` +
            `Facts: ${mem.long_term_facts.join("; ") || "none"}\n` +
            "For exact step indexes before check_step, call get_plans."
        );
    }

    private onClientMessage(raw: any) {
        if (this.closed || !this.session) return;
        let msg: any;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        try {
            if (msg.type === "audio") this.session.sendRealtimeInput({ audio: { data: msg.data, mimeType: "audio/pcm;rate=16000" } });
            else if (msg.type === "video") this.session.sendRealtimeInput({ video: { data: msg.data, mimeType: "image/jpeg" } });
            else if (msg.type === "text") this.session.sendRealtimeInput({ text: String(msg.data ?? "") });
        } catch (e) { console.error("[live] send to model failed:", e); }
    }

    private async onModelMessage(m: any) {
        // Tool calls arrive at the top level (not under serverContent).
        if (m?.toolCall?.functionCalls?.length) { await this.handleToolCall(m.toolCall); return; }

        const sc = m?.serverContent;
        const parts = sc?.modelTurn?.parts;
        if (Array.isArray(parts)) {
            for (const p of parts) {
                const d = p?.inlineData?.data;
                if (d) this.toClient({ type: "audio", data: d });
            }
        }
        if (sc?.inputTranscription?.text) this.toClient({ type: "input_transcript", text: sc.inputTranscription.text });
        if (sc?.outputTranscription?.text) this.toClient({ type: "output_transcript", text: sc.outputTranscription.text });
        if (sc?.interrupted) this.toClient({ type: "interrupted" });
        if (sc?.turnComplete) this.toClient({ type: "turn_complete" });
    }

    private async handleToolCall(toolCall: any) {
        const functionResponses: any[] = [];
        for (const fc of toolCall.functionCalls) {
            let result: unknown;
            try { result = await this.tools.run(fc.name, fc.args || {}); }
            catch (e) { result = { error: e instanceof Error ? e.message : String(e) }; }
            functionResponses.push({ id: fc.id, name: fc.name, response: { result } });
        }
        try { this.session.sendToolResponse({ functionResponses }); }
        catch (e) { console.error("[live] sendToolResponse failed:", e); }
    }

    private toClient(obj: unknown) {
        if (this.clientWs.readyState === this.clientWs.OPEN) {
            try { this.clientWs.send(JSON.stringify(obj)); } catch { /* ignore */ }
        }
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        try { this.session?.close?.(); } catch { /* ignore */ }
        this.session = null;
        try { if (this.clientWs.readyState === this.clientWs.OPEN) this.clientWs.close(); } catch { /* ignore */ }
    }
}