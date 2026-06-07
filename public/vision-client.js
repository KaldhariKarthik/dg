/*
 * DaVinci — Perception layer (client-side), emitting the agreed v1.0 schema.
 *
 * Owns: camera, frame sampling, change detection, short-term scene memory,
 * guidance rendering. Produces a structured observation per the contract and
 * hands it to the orchestrator; renders the directive it gets back.
 *
 * Wire-up: replace the inline vision <script> in index.html with this file, then:
 *
 *   VisionAgent.init({
 *     videoEl:    document.getElementById('feed'),
 *     guidanceEl: document.getElementById('guidance'),
 *     stateEl:    document.getElementById('vision-state'),
 *     dotEl:      document.getElementById('vision-dot'),
 *     statusEl:   document.getElementById('status'),
 *     sessionId:  'sess_' + crypto.randomUUID().slice(0, 6),
 *     taskContext:{ task: null, mode: 'coach' },   // set by the app when a coaching session starts
 *     orchestrate: async (observation, snapshot) => {
 *       const r = await fetch('/api/orchestrate', {
 *         method: 'POST', headers: { 'Content-Type': 'application/json' },
 *         body: JSON.stringify({ session_id: snapshot.sessionId, observation }),
 *       });
 *       return r.ok ? r.json() : null;   // -> directive (see applyDirective)
 *     },
 *   });
 *   document.getElementById('startBtn').onclick = () => VisionAgent.start();
 *   document.getElementById('stopBtn').onclick  = () => VisionAgent.stop();
 *   document.getElementById('vision-ask-btn').onclick = () => {
 *     const i = document.getElementById('vision-question');
 *     VisionAgent.ask(i.value.trim()); i.value = '';
 *   };
 */
const VisionAgent = (() => {
    const CONFIG = {
        endpoint: '/api/vision',
        sampleIntervalMs: 1800,   // base cadence while passively watching
        activeIntervalMs: 700,    // faster cadence when watching for a condition
        changeThreshold: 18,     // mean abs grayscale diff (0–255) that counts as "changed"
        diffSize: 32,     // downscaled edge used for the cheap diff
        maxEdge: 640,    // longest edge of the frame sent to the model
        jpegQ: 0.7,
        sceneMemory: 6,      // observations retained for short-term context
    };

    // --- ephemeral session state (intentionally client-only) ---
    const state = {
        running: false,
        busy: false,
        sessionId: null,
        taskContext: { task: null, mode: 'observe' },
        frameIndex: 0,
        lastSig: null,        // signature of the last SENT frame
        lastSpoken: '',
        observations: [],     // rolling [full v1.0 envelopes]
        watchFor: null,
        pendingQuestion: null,
        pendingGuidance: null,
    };

    let video, guidanceEl, stateEl, dotEl, statusEl, orchestrate, startEl, stopEl;
    let stream = null, timer = null;
    const diffCanvas = document.createElement('canvas');
    const frameCanvas = document.createElement('canvas');

    function init(opts) {
        video = opts.videoEl;
        guidanceEl = opts.guidanceEl;
        stateEl = opts.stateEl;
        dotEl = opts.dotEl;
        statusEl = opts.statusEl;
        startEl = opts.startEl || null;
        stopEl = opts.stopEl || null;
        orchestrate = opts.orchestrate || null;
        state.sessionId = opts.sessionId || ('sess_' + (crypto.randomUUID ? crypto.randomUUID().slice(0, 6) : Date.now()));
        if (opts.taskContext) state.taskContext = { ...state.taskContext, ...opts.taskContext };
        diffCanvas.width = diffCanvas.height = CONFIG.diffSize;
    }

    // Let the app/orchestrator set what the user is doing and how to behave.
    function setTaskContext(task, mode) {
        if (task !== undefined) state.taskContext.task = task;
        if (mode !== undefined) state.taskContext.mode = mode;
    }

    async function start() {
        if (state.running) return;
        setStatus('Requesting camera…');
        if (!navigator.mediaDevices?.getUserMedia) { setStatus('Camera needs https or localhost.'); return; }
        try {
            stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
            video.srcObject = stream;
            await video.play();
            setStatus('');
            state.running = true;
            state.frameIndex = 0;
            if (startEl) startEl.classList.add('hidden');
            if (stopEl) stopEl.classList.remove('hidden');
            setVisionState('WATCHING', true);
            showGuidance("Camera live. Ask a question, or I'll guide you as things change.");
            schedule(1200);
        } catch (err) {
            const map = {
                NotAllowedError: 'Permission denied — allow camera and tap Summon again.',
                NotFoundError: 'No camera found on this device.',
                NotReadableError: 'Camera busy in another app.',
            };
            setStatus(map[err.name] || ('Camera error: ' + err.name));
            console.error(err);
        }
    }

    function stop() {
        state.running = false;
        if (timer) { clearTimeout(timer); timer = null; }
        if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
        if (video) video.srcObject = null;
        state.lastSig = null;
        state.pendingGuidance = null;
        try { speechSynthesis.cancel(); } catch (_) { }
        if (startEl) startEl.classList.remove('hidden');
        if (stopEl) stopEl.classList.add('hidden');
        setVisionState('IDLE', false);
        if (guidanceEl) guidanceEl.style.opacity = '0';
    }

    // Cheap perceptual signature: tiny grayscale snapshot of the current frame.
    function frameSignature() {
        if (!video.videoWidth) return null;
        const ctx = diffCanvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(video, 0, 0, CONFIG.diffSize, CONFIG.diffSize);
        const { data } = ctx.getImageData(0, 0, CONFIG.diffSize, CONFIG.diffSize);
        const gray = new Uint8Array(CONFIG.diffSize * CONFIG.diffSize);
        for (let i = 0, p = 0; i < data.length; i += 4, p++) {
            gray[p] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
        }
        return gray;
    }

    function meanDiff(a, b) {
        if (!a || !b) return Infinity;
        let sum = 0;
        for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
        return sum / a.length;
    }

    function grabFrame() {
        const scale = CONFIG.maxEdge / Math.max(video.videoWidth, video.videoHeight);
        const w = Math.round(video.videoWidth * scale), h = Math.round(video.videoHeight * scale);
        frameCanvas.width = w; frameCanvas.height = h;
        frameCanvas.getContext('2d').drawImage(video, 0, 0, w, h);
        return frameCanvas.toDataURL('image/jpeg', CONFIG.jpegQ);
    }

    function schedule(ms) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(tick, ms ?? (state.watchFor ? CONFIG.activeIntervalMs : CONFIG.sampleIntervalMs));
    }

    async function tick() {
        if (!state.running) return;
        if (state.busy) { schedule(200); return; }

        const asked = state.pendingQuestion;
        const sig = frameSignature();
        const changed = meanDiff(sig, state.lastSig) > CONFIG.changeThreshold;

        // Keep observing even while DaVinci is talking, so a change mid-sentence
        // isn't lost — the resulting guidance just queues until the sentence ends.
        if (asked || changed || state.watchFor) await observe(asked, sig);
        schedule();
    }

    async function observe(question, sig) {
        state.busy = true;
        setVisionState('ANALYZING', true);
        try {
            const body = {
                image: grabFrame(),
                tier: question ? 'deep' : 'fast',          // model selection; distinct from task_context.mode
                session_id: state.sessionId,
                task_context: state.taskContext,
                user_transcript: question || '',
                recent: state.observations.slice(-3).map(o => o?.scene?.summary).filter(Boolean),
                media_meta: {
                    source_type: 'video_frame',
                    frame_index: ++state.frameIndex,
                    resolution: `${video.videoWidth}x${video.videoHeight}`,
                    capture_device: 'webcam',
                },
            };
            const res = await fetch(CONFIG.endpoint, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const obs = await res.json();
            if (obs.error) { showGuidance('⚠ ' + obs.error); return; }

            state.lastSig = sig;
            state.pendingQuestion = null;
            state.observations.push(obs);
            if (state.observations.length > CONFIG.sceneMemory) state.observations.shift();

            // Perception is pure description — the orchestrator decides what to say.
            const interrupt = !!question;   // an explicit ask preempts current speech
            if (orchestrate) {
                const directive = await orchestrate(obs, snapshot());
                applyDirective(directive, interrupt);
            } else {
                // Standalone fallback so the vision feature is demoable without the orchestrator.
                const anomaly = obs?.scene?.anomalies?.[0]?.description;
                speakGuide(anomaly || obs?.scene?.summary || '', interrupt);
            }
        } catch (err) {
            showGuidance('⚠ Network error — is the server running?');
            console.error(err);
        } finally {
            state.busy = false;
            if (state.running) setVisionState('WATCHING', true);
        }
    }

    // Down-direction contract (orchestrator → perception).
    function applyDirective(d, interrupt = false) {
        if (!d) return;
        if (d.task_context) state.taskContext = { ...state.taskContext, ...d.task_context };
        if (d.watch_for !== undefined) state.watchFor = d.watch_for;   // null clears it
        if (d.guidance) speakGuide(d.guidance, interrupt);
        if (d.done) { speakGuide(d.done_message || 'Done.', true); state.watchFor = null; }
        schedule();
    }

    function ask(q) {
        if (!q || !state.running) return;
        state.pendingQuestion = q;
        schedule(0);
    }

    function speakGuide(text, interrupt = false) {
        if (!text || text === state.lastSpoken) return;
        state.lastSpoken = text;
        showGuidance(text);
        try {
            if (interrupt) {                 // explicit answers cut in immediately
                state.pendingGuidance = null;
                speechSynthesis.cancel();
                speakNow(text);
            } else if (speechSynthesis.speaking || state.pendingGuidance) {
                state.pendingGuidance = text;  // queue; latest scene wins, spoken when free
            } else {
                speakNow(text);
            }
        } catch (_) { }
    }

    // Speak one line; when it finishes, flush whatever queued up while it played.
    function speakNow(text) {
        const u = new SpeechSynthesisUtterance(text);
        u.onend = () => {
            if (!state.running) return;
            const next = state.pendingGuidance;
            if (next) { state.pendingGuidance = null; speakNow(next); }
        };
        speechSynthesis.speak(u);
    }

    function showGuidance(text) {
        if (!guidanceEl) return;
        guidanceEl.textContent = text;
        guidanceEl.style.opacity = '1';
    }

    function setVisionState(label, live) {
        if (stateEl) stateEl.textContent = label;
        if (dotEl) dotEl.className = 'w-2 h-2 rounded-full ' + (live ? 'bg-error animate-pulse' : 'bg-white/30');
    }

    function setStatus(text) { if (statusEl) statusEl.textContent = text; }

    function snapshot() {
        return {
            sessionId: state.sessionId,
            taskContext: { ...state.taskContext },
            watchFor: state.watchFor,
            observations: state.observations.slice(),
        };
    }

    return { init, start, stop, ask, setTaskContext, snapshot, CONFIG };
})();

if (typeof module !== 'undefined') module.exports = VisionAgent;