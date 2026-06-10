"use strict";
(() => {
  // client/live-client.ts
  var LiveClient = (() => {
    let ws = null;
    let state = "idle";
    let cb = {};
    let micStream = null;
    let inCtx = null;
    let recorderNode = null;
    let outCtx = null;
    let playerNode = null;
    let video = null;
    let cameraTimer = null;
    let cameraStream = null;
    const frameCanvas = document.createElement("canvas");
    const cfg = { cameraIntervalMs: 1e3, cameraMaxEdge: 768, cameraJpegQ: 0.6 };
    let userBuf = "";
    let modelBuf = "";
    let muted = false;
    function setState(s) {
      state = s;
      cb.onState?.(s);
    }
    function setMuted(m) {
      muted = m;
      if (m) flushPlayback();
    }
    function init(opts = {}) {
      video = opts.videoEl ?? null;
      cb = opts.callbacks ?? {};
      if (opts.cameraIntervalMs) cfg.cameraIntervalMs = opts.cameraIntervalMs;
      if (opts.cameraMaxEdge) cfg.cameraMaxEdge = opts.cameraMaxEdge;
      if (opts.cameraJpegQ) cfg.cameraJpegQ = opts.cameraJpegQ;
    }
    function wsUrl() {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
      return `${proto}//${location.host}/live` + (tz ? `?tz=${encodeURIComponent(tz)}` : "");
    }
    function makeContext(rate) {
      try {
        return new AudioContext({ sampleRate: rate });
      } catch {
        return new AudioContext();
      }
    }
    async function start() {
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
    function openSocket() {
      return new Promise((resolve, reject) => {
        ws = new WebSocket(wsUrl());
        ws.binaryType = "arraybuffer";
        let opened = false;
        ws.onopen = () => {
          opened = true;
          setState("live");
          resolve();
        };
        ws.onmessage = (ev) => handleServerMessage(ev.data);
        ws.onerror = () => {
          if (!opened) reject(new Error("WebSocket failed to open."));
        };
        ws.onclose = () => {
          if (state !== "idle") void stop();
        };
      });
    }
    function handleServerMessage(data) {
      let msg;
      try {
        msg = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
      } catch {
        return;
      }
      switch (msg.type) {
        case "audio":
          feedAudio(msg.data);
          setState("speaking");
          break;
        case "input_transcript":
          userBuf += msg.text || "";
          cb.onUserTranscript?.(userBuf, false);
          break;
        case "output_transcript":
          modelBuf += msg.text || "";
          cb.onModelTranscript?.(modelBuf, false);
          break;
        case "interrupted":
          flushPlayback();
          if (modelBuf) {
            cb.onModelTranscript?.(modelBuf, true);
            modelBuf = "";
          }
          setState("listening");
          break;
        case "turn_complete":
          if (userBuf) {
            cb.onUserTranscript?.(userBuf, true);
            userBuf = "";
          }
          if (modelBuf) {
            cb.onModelTranscript?.(modelBuf, true);
            modelBuf = "";
          }
          setState("live");
          break;
        case "tool_event":
          cb.onToolEvent?.(msg.event, msg.data);
          break;
        case "error":
          cb.onError?.(msg.message || "Live session error.");
          break;
      }
    }
    async function setupPlayback() {
      outCtx = makeContext(24e3);
      await outCtx.audioWorklet.addModule("/worklets/pcm-player.worklet.js");
      playerNode = new AudioWorkletNode(outCtx, "pcm-player", {
        processorOptions: { sourceRate: 24e3 },
        outputChannelCount: [1]
      });
      playerNode.connect(outCtx.destination);
      if (outCtx.state === "suspended") await outCtx.resume();
    }
    function feedAudio(b64) {
      if (muted) return;
      if (!playerNode) return;
      const bytes = b64ToBytes(b64);
      const n = Math.floor(bytes.byteLength / 2);
      const int16 = new Int16Array(bytes.buffer, 0, n);
      const f32 = new Float32Array(n);
      for (let i = 0; i < n; i++) f32[i] = int16[i] / 32768;
      playerNode.port.postMessage(f32, [f32.buffer]);
    }
    function flushPlayback() {
      playerNode?.port.postMessage("flush");
    }
    async function setupCapture() {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        video: false
      });
      inCtx = makeContext(16e3);
      await inCtx.audioWorklet.addModule("/worklets/pcm-recorder.worklet.js");
      const src = inCtx.createMediaStreamSource(micStream);
      recorderNode = new AudioWorkletNode(inCtx, "pcm-recorder", { processorOptions: { targetRate: 16e3 } });
      recorderNode.port.onmessage = (e) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "audio", data: bytesToB64(new Uint8Array(e.data)) }));
        }
      };
      src.connect(recorderNode);
      const sink = inCtx.createGain();
      sink.gain.value = 0;
      recorderNode.connect(sink).connect(inCtx.destination);
      if (inCtx.state === "suspended") await inCtx.resume();
    }
    async function enableCamera() {
      if (!video) return;
      cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      video.srcObject = cameraStream;
      await video.play().catch(() => {
      });
      if (cameraTimer) clearInterval(cameraTimer);
      cameraTimer = setInterval(sendFrame, cfg.cameraIntervalMs);
    }
    function disableCamera() {
      if (cameraTimer) {
        clearInterval(cameraTimer);
        cameraTimer = null;
      }
      if (cameraStream) {
        cameraStream.getTracks().forEach((t) => t.stop());
        cameraStream = null;
      }
      if (video) video.srcObject = null;
    }
    function sendFrame() {
      if (!video || !video.videoWidth || !ws || ws.readyState !== WebSocket.OPEN) return;
      const scale = Math.min(1, cfg.cameraMaxEdge / Math.max(video.videoWidth, video.videoHeight));
      const w = Math.round(video.videoWidth * scale), h = Math.round(video.videoHeight * scale);
      frameCanvas.width = w;
      frameCanvas.height = h;
      const ctx = frameCanvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, w, h);
      const b64 = frameCanvas.toDataURL("image/jpeg", cfg.cameraJpegQ).split(",")[1] || "";
      ws.send(JSON.stringify({ type: "video", data: b64 }));
    }
    async function stop() {
      disableCamera();
      if (ws) {
        try {
          ws.close();
        } catch {
        }
        ws = null;
      }
      if (recorderNode) {
        try {
          recorderNode.disconnect();
        } catch {
        }
        recorderNode = null;
      }
      if (micStream) {
        micStream.getTracks().forEach((t) => t.stop());
        micStream = null;
      }
      if (inCtx) {
        try {
          await inCtx.close();
        } catch {
        }
        inCtx = null;
      }
      if (playerNode) {
        try {
          playerNode.disconnect();
        } catch {
        }
        playerNode = null;
      }
      if (outCtx) {
        try {
          await outCtx.close();
        } catch {
        }
        outCtx = null;
      }
      userBuf = "";
      modelBuf = "";
      setState("idle");
    }
    function sendText(text) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "text", data: text }));
    }
    function b64ToBytes(b64) {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    function bytesToB64(bytes) {
      let bin = "";
      const C = 32768;
      for (let i = 0; i < bytes.length; i += C) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + C));
      }
      return btoa(bin);
    }
    return {
      init,
      start,
      stop,
      enableCamera,
      disableCamera,
      sendText,
      setMuted,
      isMuted: () => muted,
      isLive: () => state !== "idle" && state !== "error",
      getState: () => state
    };
  })();
  window.LiveClient = LiveClient;
})();
//# sourceMappingURL=live-client.js.map
