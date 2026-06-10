"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LiveSession = void 0;
const genai_1 = require("@google/genai");
const tools_1 = require("./tools");
class LiveSession {
    clientWs;
    userId;
    cfg;
    timeZone;
    ai;
    session = null;
    closed = false;
    tools;
    constructor(clientWs, userId, cfg, timeZone = "UTC") {
        this.clientWs = clientWs;
        this.userId = userId;
        this.cfg = cfg;
        this.timeZone = timeZone;
        this.ai = new genai_1.GoogleGenAI({ apiKey: cfg.apiKey });
        this.tools = new tools_1.LiveToolRunner(userId, cfg.deps, (event, data) => this.toClient({ type: "tool_event", event, data }));
    }
    async start() {
        let contextBlock = "";
        try {
            contextBlock = await this.buildContext();
        }
        catch (e) {
            console.error("[live] context load failed:", e);
        }
        try {
            this.session = await this.ai.live.connect({
                model: this.cfg.model,
                config: {
                    responseModalities: [genai_1.Modality.AUDIO], // do NOT add TEXT — it breaks transcription
                    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.cfg.voice } } },
                    inputAudioTranscription: {},
                    outputAudioTranscription: {},
                    systemInstruction: this.cfg.systemInstruction + contextBlock,
                    tools: [{ functionDeclarations: tools_1.TOOL_DECLARATIONS }],
                },
                callbacks: {
                    onopen: () => this.toClient({ type: "ready" }),
                    onmessage: (m) => this.onModelMessage(m),
                    onerror: (e) => this.toClient({ type: "error", message: e?.message || "live error" }),
                    onclose: () => this.toClient({ type: "closed" }),
                },
            });
        }
        catch (err) {
            console.error("[live] connect failed:", err instanceof Error ? err.message : err);
            this.toClient({ type: "error", message: "Could not open the live session." });
            this.close();
            return;
        }
        this.clientWs.on("message", (raw) => this.onClientMessage(raw));
        this.clientWs.on("close", () => this.close());
        this.clientWs.on("error", () => this.close());
    }
    async buildContext() {
        const [plans, mem] = await Promise.all([
            this.cfg.deps.plans.listPlans(this.userId),
            this.cfg.deps.memory.loadMemory(this.userId),
        ]);
        const planLines = plans.slice(0, 8).map((p) => {
            const done = p.steps.filter((s) => s.done).length;
            return `- "${p.goal}" (id: ${p.id}, ${done}/${p.steps.length} done)`;
        }).join("\n") || "(none yet)";
        const prefs = Object.entries(mem.preferences).map(([k, v]) => `${k}: ${v}`).join("; ") || "none";
        const now = new Date();
        const nowLocal = new Intl.DateTimeFormat("en-US", {
            timeZone: this.timeZone,
            weekday: "long", year: "numeric", month: "long", day: "numeric",
            hour: "numeric", minute: "2-digit", timeZoneName: "short",
        }).format(now);
        const timeContext = `\n\nThe current date and time is ${nowLocal} (${this.timeZone}); ISO ${now.toISOString()}. ` +
            `Treat this as "now" when interpreting "today", "tomorrow", "this afternoon", "next week", etc., ` +
            `and always pass RFC3339 timestamps with the correct offset to the calendar tools.`;
        return (timeContext +
            "\n\nWhat you already know about this user (use naturally, don't recite):\n" +
            `Plans:\n${planLines}\n` +
            `Preferences: ${prefs}\n` +
            `Patterns: ${mem.past_patterns.join("; ") || "none"}\n` +
            `Facts: ${mem.long_term_facts.join("; ") || "none"}\n` +
            "For exact step indexes before check_step, call get_plans.");
    }
    onClientMessage(raw) {
        if (this.closed || !this.session)
            return;
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        }
        catch {
            return;
        }
        try {
            if (msg.type === "audio")
                this.session.sendRealtimeInput({ audio: { data: msg.data, mimeType: "audio/pcm;rate=16000" } });
            else if (msg.type === "video")
                this.session.sendRealtimeInput({ video: { data: msg.data, mimeType: "image/jpeg" } });
            else if (msg.type === "text")
                this.session.sendRealtimeInput({ text: String(msg.data ?? "") });
        }
        catch (e) {
            console.error("[live] send to model failed:", e);
        }
    }
    async onModelMessage(m) {
        // Tool calls arrive at the top level (not under serverContent).
        if (m?.toolCall?.functionCalls?.length) {
            await this.handleToolCall(m.toolCall);
            return;
        }
        const sc = m?.serverContent;
        const parts = sc?.modelTurn?.parts;
        if (Array.isArray(parts)) {
            for (const p of parts) {
                const d = p?.inlineData?.data;
                if (d)
                    this.toClient({ type: "audio", data: d });
            }
        }
        if (sc?.inputTranscription?.text)
            this.toClient({ type: "input_transcript", text: sc.inputTranscription.text });
        if (sc?.outputTranscription?.text)
            this.toClient({ type: "output_transcript", text: sc.outputTranscription.text });
        if (sc?.interrupted)
            this.toClient({ type: "interrupted" });
        if (sc?.turnComplete)
            this.toClient({ type: "turn_complete" });
    }
    async handleToolCall(toolCall) {
        const functionResponses = [];
        for (const fc of toolCall.functionCalls) {
            let result;
            try {
                result = await this.tools.run(fc.name, fc.args || {});
            }
            catch (e) {
                result = { error: e instanceof Error ? e.message : String(e) };
            }
            functionResponses.push({ id: fc.id, name: fc.name, response: { result } });
        }
        try {
            this.session.sendToolResponse({ functionResponses });
        }
        catch (e) {
            console.error("[live] sendToolResponse failed:", e);
        }
    }
    toClient(obj) {
        if (this.clientWs.readyState === this.clientWs.OPEN) {
            try {
                this.clientWs.send(JSON.stringify(obj));
            }
            catch { /* ignore */ }
        }
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        try {
            this.session?.close?.();
        }
        catch { /* ignore */ }
        this.session = null;
        try {
            if (this.clientWs.readyState === this.clientWs.OPEN)
                this.clientWs.close();
        }
        catch { /* ignore */ }
    }
}
exports.LiveSession = LiveSession;
//# sourceMappingURL=liveSession.js.map