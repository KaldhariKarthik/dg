// public/worklets/pcm-recorder.worklet.js
// Mic capture on the audio thread. Linear-resamples the context's native rate
// down to 16 kHz, converts Float32 -> Int16 LE (what Gemini Live wants), batches
// ~100ms, and posts the raw ArrayBuffer to the main thread. Defensive resample
// means it's correct whether or not the 16 kHz context hint was honored.
class PCMRecorder extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const opts = (options && options.processorOptions) || {};
        this.targetRate = opts.targetRate || 16000;
        this.ratio = sampleRate / this.targetRate; // input samples per output sample
        this.chunk = Math.round(this.targetRate * 0.1); // ~100ms @ target rate
        this.buf = new Float32Array(this.chunk);
        this.count = 0;
        this.pos = 0; // fractional read cursor carried across render quanta
    }
    process(inputs) {
        const input = inputs[0];
        const ch = input && input[0];
        if (!ch || ch.length === 0) return true;
        while (this.pos < ch.length) {
            const i0 = Math.floor(this.pos);
            const i1 = Math.min(i0 + 1, ch.length - 1);
            const frac = this.pos - i0;
            this.buf[this.count++] = ch[i0] * (1 - frac) + ch[i1] * frac;
            if (this.count >= this.chunk) this.flush();
            this.pos += this.ratio;
        }
        this.pos -= ch.length; // keep the fractional remainder for the next quantum
        return true;
    }
    flush() {
        const pcm = new Int16Array(this.count);
        for (let i = 0; i < this.count; i++) {
            const s = Math.max(-1, Math.min(1, this.buf[i]));
            pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        this.port.postMessage(pcm.buffer, [pcm.buffer]); // zero-copy transfer
        this.count = 0;
    }
}
registerProcessor("pcm-recorder", PCMRecorder);