/*
 * client/live-client.ts — DaVinci live voice + vision client.
 *
 * One persistent WebSocket to OUR server (never to Google directly). Up: mic
 * audio (16kHz PCM16) + JPEG frames when the camera is on. Down: the model's
 * native audio (24kHz PCM16), live input/output transcripts, and control
 * signals (interrupted / turn_complete). Capture and playback run on
 * AudioWorklets; barge-in flushes the player instantly. esbuild bundles this to
 * public/live-client.js; the worklets are served as-is from public/worklets/.
 */

type LiveState = "idle" | "connecting" | "live" | "listening" | "speaking" | "error";

interface LiveCallbacks {
    onState?: (s: LiveState) => void;
    onUserTranscript?: (text: string, final: boolean) => void;
    onModelTranscript?: (text: string, final: boolean) => void;
    onError?: (message: string) => void;
    onToolEvent?: (event: string, data: any) => void;
}
interface LiveInitOptions {
    videoEl?: HTMLVideoElement | null;
    cameraIntervalMs?: number;
    cameraMaxEdge?: number;
    cameraJpegQ?: number;
    callbacks?: LiveCallbacks;
}

const LiveClient = (() => {
    let ws: WebSocket | null = null;
    let state: LiveState = "idle";
    let cb: LiveCallbacks = {};

    let micStream: MediaStream | null = null;
    let inCtx: AudioContext | null = null;
    let recorderNode: AudioWorkletNode | null = null;

    let outCtx: AudioContext | null = null;
    let playerNode: AudioWorkletNode | null = null;

    let video: HTMLVideoElement | null = null;
    let cameraTimer: ReturnType<typeof setInterval> | null = null;
    let cameraStream: MediaStream | null = null;
    const frameCanvas = document.createElement("canvas");
    const cfg = { cameraIntervalMs: 1000, cameraMaxEdge: 768, cameraJpegQ: 0.6 };

    let userBuf = "";
    let modelBuf = "";
    let muted = false;

    function setState(s: LiveState) { state = s; cb.onState?.(s); }
    function setMuted(m: boolean) { muted = m; if (m) flushPlayback(); }

    function init(opts: LiveInitOptions = {}) {
        video = opts.videoEl ?? null;
        cb = opts.callbacks ?? {};
        if (opts.cameraIntervalMs) cfg.cameraIntervalMs = opts.cameraIntervalMs;
        if (opts.cameraMaxEdge) cfg.cameraMaxEdge = opts.cameraMaxEdge;
        if (opts.cameraJpegQ) cfg.cameraJpegQ = opts.cameraJpegQ;
    }

    function wsUrl(): string {
        const proto = location.protocol === "https:" ? "wss:" : "ws:";
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
        return `${proto}//${location.host}/live` + (tz ? `?tz=${encodeURIComponent(tz)}` : "");
    }
    function makeContext(rate: number): AudioContext {
        try { return new AudioContext({ sampleRate: rate }); }
        catch { return new AudioContext(); } // worklets resample defensively anyway
    }

    async function start(): Promise<void> {
        if (state !== "idle" && state !== "error") return;
        setState("connecting");
        try {
            await setupPlayback();
            await setupCapture();
            await openSocket();
        } catch (err) {
            console.error("[live] start failed", err);
            cb.onError?.(err instanceof Error ? err.message : "Could not start live session.");
            await stop();
            setState("error");
        }
    }

    function openSocket(): Promise<void> {
        return new Promise((resolve, reject) => {
            ws = new WebSocket(wsUrl());
            ws.binaryType = "arraybuffer";
            let opened = false;
            ws.onopen = () => { opened = true; setState("live"); resolve(); };
            ws.onmessage = (ev) => handleServerMessage(ev.data);
            ws.onerror = () => { if (!opened) reject(new Error("WebSocket failed to open.")); };
            ws.onclose = () => { if (state !== "idle") void stop(); };
        });
    }

    function handleServerMessage(data: unknown) {
        let msg: any;
        try { msg = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer)); }
        catch { return; }
        switch (msg.type) {
            case "audio": feedAudio(msg.data); setState("speaking"); break;
            case "input_transcript":
                userBuf += msg.text || ""; cb.onUserTranscript?.(userBuf, false); break;
            case "output_transcript":
                modelBuf += msg.text || ""; cb.onModelTranscript?.(modelBuf, false); break;
            case "interrupted":
                flushPlayback();
                if (modelBuf) { cb.onModelTranscript?.(modelBuf, true); modelBuf = ""; }
                setState("listening"); break;
            case "turn_complete":
                if (userBuf) { cb.onUserTranscript?.(userBuf, true); userBuf = ""; }
                if (modelBuf) { cb.onModelTranscript?.(modelBuf, true); modelBuf = ""; }
                setState("live"); break;
            case "tool_event": cb.onToolEvent?.(msg.event, msg.data); break;
            case "error": cb.onError?.(msg.message || "Live session error."); break;
        }
    }

    /* ---- audio out ---- */
    async function setupPlayback() {
        outCtx = makeContext(24000);
        await outCtx.audioWorklet.addModule("/worklets/pcm-player.worklet.js");
        playerNode = new AudioWorkletNode(outCtx, "pcm-player", {
            processorOptions: { sourceRate: 24000 }, outputChannelCount: [1],
        });
        playerNode.connect(outCtx.destination);
        if (outCtx.state === "suspended") await outCtx.resume();
    }
    function feedAudio(b64: string) {
        if (muted) return;
        if (!playerNode) return;
        const bytes = b64ToBytes(b64);
        const n = Math.floor(bytes.byteLength / 2);
        const int16 = new Int16Array(bytes.buffer, 0, n);
        const f32 = new Float32Array(n);
        for (let i = 0; i < n; i++) f32[i] = int16[i] / 0x8000;
        playerNode.port.postMessage(f32, [f32.buffer]);
    }
    function flushPlayback() { playerNode?.port.postMessage("flush"); }

    /* ---- audio in ---- */
    async function setupCapture() {
        micStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
            video: false,
        });
        inCtx = makeContext(16000);
        await inCtx.audioWorklet.addModule("/worklets/pcm-recorder.worklet.js");
        const src = inCtx.createMediaStreamSource(micStream);
        recorderNode = new AudioWorkletNode(inCtx, "pcm-recorder", { processorOptions: { targetRate: 16000 } });
        recorderNode.port.onmessage = (e) => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "audio", data: bytesToB64(new Uint8Array(e.data as ArrayBuffer)) }));
            }
        };
        src.connect(recorderNode);
        const sink = inCtx.createGain(); sink.gain.value = 0; // keep the node processing
        recorderNode.connect(sink).connect(inCtx.destination);
        if (inCtx.state === "suspended") await inCtx.resume();
    }

    /* ---- video ---- */
    async function enableCamera(): Promise<void> {
        if (!video) return;
        cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        video.srcObject = cameraStream;
        await video.play().catch(() => { });
        if (cameraTimer) clearInterval(cameraTimer);
        cameraTimer = setInterval(sendFrame, cfg.cameraIntervalMs);
    }
    function disableCamera(): void {
        if (cameraTimer) { clearInterval(cameraTimer); cameraTimer = null; }
        if (cameraStream) { cameraStream.getTracks().forEach((t) => t.stop()); cameraStream = null; }
        if (video) video.srcObject = null;
    }
    function sendFrame(): void {
        if (!video || !video.videoWidth || !ws || ws.readyState !== WebSocket.OPEN) return;
        const scale = Math.min(1, cfg.cameraMaxEdge / Math.max(video.videoWidth, video.videoHeight));
        const w = Math.round(video.videoWidth * scale), h = Math.round(video.videoHeight * scale);
        frameCanvas.width = w; frameCanvas.height = h;
        const ctx = frameCanvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(video, 0, 0, w, h);
        const b64 = (frameCanvas.toDataURL("image/jpeg", cfg.cameraJpegQ).split(",")[1]) || "";
        ws.send(JSON.stringify({ type: "video", data: b64 }));
    }

    /* ---- lifecycle ---- */
    async function stop(): Promise<void> {
        disableCamera();
        if (ws) { try { ws.close(); } catch { } ws = null; }
        if (recorderNode) { try { recorderNode.disconnect(); } catch { } recorderNode = null; }
        if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
        if (inCtx) { try { await inCtx.close(); } catch { } inCtx = null; }
        if (playerNode) { try { playerNode.disconnect(); } catch { } playerNode = null; }
        if (outCtx) { try { await outCtx.close(); } catch { } outCtx = null; }
        userBuf = ""; modelBuf = "";
        setState("idle");
    }
    function sendText(text: string): void {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "text", data: text }));
    }

    /* ---- helpers ---- */
    function b64ToBytes(b64: string): Uint8Array {
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }
    function bytesToB64(bytes: Uint8Array): string {
        let bin = ""; const C = 0x8000;
        for (let i = 0; i < bytes.length; i += C) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + C) as unknown as number[]);
        }
        return btoa(bin);
    }

    return {
        init, start, stop, enableCamera, disableCamera, sendText, setMuted,
        isMuted: () => muted,
        isLive: () => state !== "idle" && state !== "error",
        getState: () => state,
    };
})();

declare global { interface Window { LiveClient: typeof LiveClient; } }
window.LiveClient = LiveClient;
export { };