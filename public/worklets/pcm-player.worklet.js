// public/worklets/pcm-player.worklet.js
// Gapless playback. Main thread ships Float32 chunks (decoded from the model's
// 24 kHz PCM16); this drains a ring buffer at the output context's rate,
// resampling from 24 kHz so pitch is right regardless of context rate. A
// "flush" message empties it instantly — that's barge-in cutting the model off.
class PCMPlayer extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const opts = (options && options.processorOptions) || {};
        this.sourceRate = opts.sourceRate || 24000;
        this.ratio = this.sourceRate / sampleRate; // source samples per output sample
        this.queue = [];
        this.current = null;
        this.read = 0;
        this.port.onmessage = (e) => {
            const d = e.data;
            if (d === "flush") { this.queue.length = 0; this.current = null; this.read = 0; return; }
            if (d instanceof Float32Array) this.queue.push(d);
        };
    }
    next() {
        if (!this.current || this.read >= this.current.length) {
            this.current = this.queue.shift() || null;
            this.read = 0;
            if (!this.current) return 0; // underflow -> silence
        }
        const i0 = Math.floor(this.read);
        const i1 = Math.min(i0 + 1, this.current.length - 1);
        const frac = this.read - i0;
        const s = this.current[i0] * (1 - frac) + this.current[i1] * frac;
        this.read += this.ratio;
        return s;
    }
    process(_in, outputs) {
        const out = outputs[0];
        const ch = out[0];
        for (let i = 0; i < ch.length; i++) ch[i] = this.next();
        for (let c = 1; c < out.length; c++) out[c].set(ch);
        return true;
    }
}
registerProcessor("pcm-player", PCMPlayer);