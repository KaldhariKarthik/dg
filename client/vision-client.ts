/*
 * DaVinci — Perception layer (client), TypeScript.
 *
 * Converted from public/vision-client.js. It now imports the v1.0 observation
 * and directive shapes from the server's contract (src/core/types.ts), so there
 * is ONE definition of the schema instead of a hand-kept copy here. esbuild
 * bundles this file to public/vision-client.js (see package.json scripts); the
 * type-only imports are erased, so nothing from the server runtime is pulled in.
 *
 * Two hardening fixes are folded into this conversion:
 *   A1  Active-watch no longer fans out: even with a watch_for condition active,
 *       a frame is only sent when it CHANGED (lower threshold + faster cadence),
 *       so a static scene under watch costs nothing.
 *   A2  A failed observation no longer re-sends the same frame on a tight loop:
 *       on error we mark the frame seen, drop the pending question, and back off
 *       exponentially (capped) so a failing endpoint isn't hammered.
 *
 * Owns: camera, frame sampling, change detection, short-term scene memory,
 * guidance rendering. Produces a structured observation per the contract and
 * hands it to the orchestrator; renders the directive it gets back.
 */

import type { VisionObservation, VisionDirective } from "../src/core/types";

interface VisionConfig {
    endpoint: string;
    sampleIntervalMs: number;
    activeIntervalMs: number;
    changeThreshold: number;
    activeChangeThreshold: number;
    diffSize: number;
    maxEdge: number;
    jpegQ: number;
    sceneMemory: number;
    maxBackoffMs: number;
}

interface ClientTaskContext {
    task: string | null;
    mode: string;
}

interface SessionInfo {
    mode: "describe" | "guided";
    planId: string | null;
}

interface VisionSnapshot {
    sessionId: string | null;
    taskContext: ClientTaskContext;
    watchFor: string | null;
    observations: VisionObservation[];
    session: SessionInfo;
}

type Orchestrate = (
    observation: VisionObservation,
    snapshot: VisionSnapshot
) => Promise<VisionDirective | null>;

type SessionEnd = (info: { planId: string | null; summaries: string[] }) => void;

interface VisionInitOptions {
    videoEl: HTMLVideoElement;
    guidanceEl: HTMLElement;
    stateEl: HTMLElement;
    dotEl: HTMLElement;
    statusEl: HTMLElement;
    startEl?: HTMLElement | null;
    stopEl?: HTMLElement | null;
    sessionId?: string;
    taskContext?: Partial<ClientTaskContext>;
    orchestrate?: Orchestrate;
    /** 6D: fired when a GUIDED session ends (unsummon), with its scene log. */
    onSessionEnd?: SessionEnd;
}

const VisionAgent = (() => {
    const CONFIG: VisionConfig = {
        endpoint: "/api/vision",
        sampleIntervalMs: 1800, // base cadence while passively watching
        activeIntervalMs: 700, // faster cadence when a watch condition is active
        changeThreshold: 18, // mean abs grayscale diff (0-255) counted as "changed"
        activeChangeThreshold: 8, // more sensitive while actively watching
        diffSize: 32, // downscaled edge used for the cheap diff
        maxEdge: 640, // longest edge of the frame sent to the model
        jpegQ: 0.7,
        sceneMemory: 6, // observations retained for short-term context
        maxBackoffMs: 15000, // cap on error backoff
    };

    // --- ephemeral session state (intentionally client-only) ---
    const state = {
        running: false,
        busy: false,
        sessionId: null as string | null,
        taskContext: { task: null, mode: "observe" } as ClientTaskContext,
        frameIndex: 0,
        lastSig: null as Uint8Array | null, // signature of the last SENT frame
        lastSpoken: "",
        observations: [] as VisionObservation[],
        watchFor: null as string | null,
        pendingQuestion: null as string | null,
        pendingGuidance: null as string | null,
        consecutiveErrors: 0,
        session: { mode: "describe", planId: null } as SessionInfo,
        sessionLog: [] as string[], // 6D: scene summaries accrued during a guided session
    };

    let video: HTMLVideoElement;
    let guidanceEl: HTMLElement;
    let stateEl: HTMLElement;
    let dotEl: HTMLElement;
    let statusEl: HTMLElement;
    let startEl: HTMLElement | null = null;
    let stopEl: HTMLElement | null = null;
    let orchestrate: Orchestrate | null = null;
    let onSessionEnd: SessionEnd | null = null;

    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const diffCanvas = document.createElement("canvas");
    const frameCanvas = document.createElement("canvas");

    function init(opts: VisionInitOptions): void {
        video = opts.videoEl;
        guidanceEl = opts.guidanceEl;
        stateEl = opts.stateEl;
        dotEl = opts.dotEl;
        statusEl = opts.statusEl;
        startEl = opts.startEl ?? null;
        stopEl = opts.stopEl ?? null;
        orchestrate = opts.orchestrate ?? null;
        onSessionEnd = opts.onSessionEnd ?? null;
        state.sessionId =
            opts.sessionId ||
            "sess_" + (crypto.randomUUID ? crypto.randomUUID().slice(0, 6) : String(Date.now()));
        if (opts.taskContext) state.taskContext = { ...state.taskContext, ...opts.taskContext };
        diffCanvas.width = diffCanvas.height = CONFIG.diffSize;
    }

    // Let the app/orchestrator set what the user is doing and how to behave.
    function setTaskContext(task?: string | null, mode?: string): void {
        if (task !== undefined) state.taskContext.task = task;
        if (mode !== undefined) state.taskContext.mode = mode;
    }

    async function start(): Promise<void> {
        if (state.running) return;
        setStatus("Requesting camera…");
        if (!navigator.mediaDevices?.getUserMedia) {
            setStatus("Camera needs https or localhost.");
            return;
        }
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: "environment" },
                audio: false,
            });
            video.srcObject = stream;
            await video.play();
            setStatus("");
            state.running = true;
            state.frameIndex = 0;
            state.consecutiveErrors = 0;
            if (startEl) startEl.classList.add("hidden");
            if (stopEl) stopEl.classList.remove("hidden");
            setVisionState("WATCHING", true);
            showGuidance("Camera live. Ask a question, or I'll guide you as things change.");
            schedule(1200);
        } catch (err) {
            const name = err instanceof DOMException ? err.name : "";
            const map: Record<string, string> = {
                NotAllowedError: "Permission denied — allow camera and tap Summon again.",
                NotFoundError: "No camera found on this device.",
                NotReadableError: "Camera busy in another app.",
            };
            setStatus(map[name] || "Camera error: " + (name || "unknown"));
            console.error(err);
        }
    }

    function stop(): void {
        const endedGuided = state.session.mode === "guided";
        const endedPlanId = state.session.planId;
        const endedLog = state.sessionLog.slice();
        state.running = false;
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
        if (stream) {
            stream.getTracks().forEach((t) => t.stop());
            stream = null;
        }
        if (video) video.srcObject = null;
        state.lastSig = null;
        state.pendingGuidance = null;
        state.consecutiveErrors = 0;
        state.session = { mode: "describe", planId: null };
        state.sessionLog = [];
        try {
            speechSynthesis.cancel();
        } catch {
            /* speech unsupported */
        }
        if (startEl) startEl.classList.remove("hidden");
        if (stopEl) stopEl.classList.add("hidden");
        setVisionState("IDLE", false);
        if (guidanceEl) guidanceEl.style.opacity = "0";

        // 6D: a guided session that just ended hands its scene log to the app,
        // which extracts durable memory + speaks a recap. Fire-and-forget.
        if (endedGuided && onSessionEnd) {
            try {
                onSessionEnd({ planId: endedPlanId, summaries: endedLog });
            } catch {
                /* no-op */
            }
        }
    }

    // Cheap perceptual signature: tiny grayscale snapshot of the current frame.
    function frameSignature(): Uint8Array | null {
        if (!video.videoWidth) return null;
        const ctx = diffCanvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return null;
        ctx.drawImage(video, 0, 0, CONFIG.diffSize, CONFIG.diffSize);
        const { data } = ctx.getImageData(0, 0, CONFIG.diffSize, CONFIG.diffSize);
        const gray = new Uint8Array(CONFIG.diffSize * CONFIG.diffSize);
        for (let i = 0, p = 0; i < data.length; i += 4, p++) {
            gray[p] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
        }
        return gray;
    }

    function meanDiff(a: Uint8Array | null, b: Uint8Array | null): number {
        if (!a || !b || a.length !== b.length) return Infinity;
        let sum = 0;
        for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
        return sum / a.length;
    }

    function grabFrame(): string {
        const scale = CONFIG.maxEdge / Math.max(video.videoWidth, video.videoHeight);
        const w = Math.round(video.videoWidth * scale);
        const h = Math.round(video.videoHeight * scale);
        frameCanvas.width = w;
        frameCanvas.height = h;
        const ctx = frameCanvas.getContext("2d");
        if (ctx) ctx.drawImage(video, 0, 0, w, h);
        return frameCanvas.toDataURL("image/jpeg", CONFIG.jpegQ);
    }

    // Active watch lowers the change threshold (more sensitive) and quickens the
    // cadence — but it still only SENDS on change (A1). A persistent error grows
    // the delay so a failing endpoint isn't hammered (A2).
    function nextDelay(): number {
        const base = state.watchFor ? CONFIG.activeIntervalMs : CONFIG.sampleIntervalMs;
        if (state.consecutiveErrors > 0) {
            return Math.min(base * 2 ** state.consecutiveErrors, CONFIG.maxBackoffMs);
        }
        return base;
    }

    function schedule(ms?: number): void {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(tick, ms ?? nextDelay());
    }

    async function tick(): Promise<void> {
        if (!state.running) return;
        if (state.busy) {
            schedule(200);
            return;
        }

        const asked = state.pendingQuestion;
        const sig = frameSignature();
        // A1: gate on change even while a watch condition is active, so a static
        // scene costs nothing. A spoken question always observes.
        const threshold = state.watchFor ? CONFIG.activeChangeThreshold : CONFIG.changeThreshold;
        const changed = meanDiff(sig, state.lastSig) > threshold;

        if (asked || changed) await observe(asked, sig);
        schedule();
    }

    // A2: a failed frame is marked seen and we back off, instead of re-sending it
    // on the next tick. A pending question is dropped so it can't loop either.
    function onObserveError(sig: Uint8Array | null, message: string): void {
        state.lastSig = sig;
        state.pendingQuestion = null;
        state.consecutiveErrors++;
        showGuidance("⚠ " + message);
    }

    async function observe(question: string | null, sig: Uint8Array | null): Promise<void> {
        state.busy = true;
        setVisionState("ANALYZING", true);
        try {
            const body = {
                image: grabFrame(),
                tier: question ? "deep" : "fast", // model selection; distinct from task_context.mode
                session_id: state.sessionId,
                task_context: state.taskContext,
                user_transcript: question || "",
                recent: state.observations
                    .slice(-3)
                    .map((o) => o?.scene?.summary)
                    .filter((s): s is string => !!s),
                media_meta: {
                    source_type: "video_frame",
                    frame_index: ++state.frameIndex,
                    resolution: `${video.videoWidth}x${video.videoHeight}`,
                    capture_device: "webcam",
                },
            };
            const res = await fetch(CONFIG.endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const obs = (await res.json()) as VisionObservation & { error?: string };
            if (!res.ok || obs.error) {
                onObserveError(sig, obs.error || `Server error (${res.status}).`);
                return;
            }

            // Success: clear backoff and commit this frame as the new baseline.
            state.consecutiveErrors = 0;
            state.lastSig = sig;
            state.pendingQuestion = null;
            state.observations.push(obs);
            if (state.observations.length > CONFIG.sceneMemory) state.observations.shift();

            // 6D: accrue the guided session's scene story for end-of-session memory.
            if (state.session.mode === "guided") {
                const sum = obs.scene?.summary?.trim();
                if (sum && sum !== state.sessionLog[state.sessionLog.length - 1]) {
                    state.sessionLog.push(sum);
                    if (state.sessionLog.length > 20) state.sessionLog.shift();
                }
            }

            // Perception is pure description — the orchestrator decides what to say.
            const interrupt = !!question; // an explicit ask preempts current speech
            if (orchestrate) {
                const directive = await orchestrate(obs, snapshot());
                applyDirective(directive, interrupt);
            } else {
                // Standalone fallback so the vision feature is demoable without the orchestrator.
                const anomaly = obs?.scene?.anomalies?.[0]?.description;
                speakGuide(anomaly || obs?.scene?.summary || "", interrupt);
            }
        } catch (err) {
            onObserveError(sig, "Network error — is the server running?");
            console.error(err);
        } finally {
            state.busy = false;
            if (state.running) setVisionState("WATCHING", true);
        }
    }

    // Down-direction contract (orchestrator → perception).
    function applyDirective(d: VisionDirective | null, interrupt = false): void {
        if (!d) return;
        if (d.task_context) state.taskContext = { ...state.taskContext, ...d.task_context };
        state.watchFor = d.watch_for ?? null; // null clears it
        if (d.guidance) speakGuide(d.guidance, interrupt);
        if (d.done) {
            speakGuide(d.done_message || "Done.", true);
            state.watchFor = null;
        }
        schedule();
    }

    function ask(q: string): void {
        if (!q || !state.running) return;
        state.pendingQuestion = q;
        schedule(0);
    }

    // Set the session mode without touching the camera (e.g. elevate mid-stream).
    function setSession(mode: "describe" | "guided", planId: string | null = null): void {
        if (mode === "guided") state.sessionLog = [];
        state.session = { mode, planId };
    }

    // Start (or elevate to) a guided session bound to one plan, summoning the
    // camera if it isn't already live. The actual plan grounding happens server
    // side — the client just declares "this session is guiding plan X".
    function startGuided(planId: string): void {
        state.sessionLog = [];
        state.session = { mode: "guided", planId };
        if (!state.running) void start();
        else schedule(0);
    }

    function speakGuide(text: string, interrupt = false): void {
        if (!text || text === state.lastSpoken) return;
        state.lastSpoken = text;
        showGuidance(text);
        try {
            if (interrupt) {
                // explicit answers cut in immediately
                state.pendingGuidance = null;
                speechSynthesis.cancel();
                speakNow(text);
            } else if (speechSynthesis.speaking || state.pendingGuidance) {
                state.pendingGuidance = text; // queue; latest scene wins, spoken when free
            } else {
                speakNow(text);
            }
        } catch {
            /* speech unsupported; caption already shown */
        }
    }

    // Speak one line; when it finishes, flush whatever queued up while it played.
    function speakNow(text: string): void {
        const u = new SpeechSynthesisUtterance(text);
        u.onend = () => {
            if (!state.running) return;
            const next = state.pendingGuidance;
            if (next) {
                state.pendingGuidance = null;
                speakNow(next);
            }
        };
        speechSynthesis.speak(u);
    }

    function showGuidance(text: string): void {
        if (!guidanceEl) return;
        guidanceEl.textContent = text;
        guidanceEl.style.opacity = "1";
    }

    function setVisionState(label: string, live: boolean): void {
        if (stateEl) stateEl.textContent = label;
        if (dotEl) dotEl.className = "w-2 h-2 rounded-full " + (live ? "bg-error animate-pulse" : "bg-white/30");
    }

    function setStatus(text: string): void {
        if (statusEl) statusEl.textContent = text;
    }

    function snapshot(): VisionSnapshot {
        return {
            sessionId: state.sessionId,
            taskContext: { ...state.taskContext },
            watchFor: state.watchFor,
            observations: state.observations.slice(),
            session: { ...state.session },
        };
    }

    return { init, start, stop, ask, setSession, startGuided, setTaskContext, snapshot, CONFIG };
})();

declare global {
    interface Window {
        VisionAgent: typeof VisionAgent;
    }
}

// esbuild bundles this file as an IIFE; exposing on window keeps index.html's
// inline wiring (VisionAgent.init / .start / .stop / .ask) working unchanged,
// and makes window.VisionAgent truthy so showScreen()'s stop-on-leave fires.
window.VisionAgent = VisionAgent;

export { };