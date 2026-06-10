"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Embedder = void 0;
exports.chunkText = chunkText;
exports.cosineSim = cosineSim;
/**
 * src/recall/embeddings.ts — text chunking + Gemini embeddings + cosine search.
 * Self-contained: depends only on @google/genai. Documents are embedded with
 * taskType RETRIEVAL_DOCUMENT and queries with RETRIEVAL_QUERY (the asymmetry
 * Google's retrieval models are trained for — mixing them quietly degrades
 * recall). Vectors are L2-comparable; we use plain cosine similarity.
 */
const genai_1 = require("@google/genai");
const EMBED_MODEL = (process.env.EMBED_MODEL ?? "gemini-embedding-001").trim();
const EMBED_DIMS = Number(process.env.EMBED_DIMS ?? 768);
const BATCH = 50; // stay well under batch + RPM limits
/** Greedy char-based chunker with overlap. ~1500 chars keeps us under the
 *  2048-token embedding input limit with margin, and the overlap stops ideas
 *  from being severed at a boundary. Splits on paragraph breaks when it can. */
function chunkText(text, maxChars = 1500, overlap = 200) {
    const clean = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (clean.length <= maxChars)
        return clean ? [clean] : [];
    const paras = clean.split(/\n\n+/);
    const chunks = [];
    let buf = "";
    const flush = () => { if (buf.trim())
        chunks.push(buf.trim()); buf = ""; };
    for (const p of paras) {
        if (p.length > maxChars) {
            flush();
            for (let i = 0; i < p.length; i += maxChars - overlap) {
                chunks.push(p.slice(i, i + maxChars).trim());
            }
            continue;
        }
        if ((buf + "\n\n" + p).length > maxChars) {
            const tail = buf.slice(-overlap);
            flush();
            buf = tail ? tail + "\n\n" + p : p;
        }
        else {
            buf = buf ? buf + "\n\n" + p : p;
        }
    }
    flush();
    return chunks;
}
class Embedder {
    ai;
    constructor(apiKey) { this.ai = new genai_1.GoogleGenAI({ apiKey }); }
    /** Embed many document chunks. Batched + sequential to respect rate limits. */
    async embedDocuments(texts) {
        const out = [];
        for (let i = 0; i < texts.length; i += BATCH) {
            const slice = texts.slice(i, i + BATCH);
            const vecs = await this.embedBatch(slice, "RETRIEVAL_DOCUMENT");
            out.push(...vecs);
        }
        return out;
    }
    /** Embed a single search query. */
    async embedQuery(text) {
        const [v] = await this.embedBatch([text], "RETRIEVAL_QUERY");
        return v ?? [];
    }
    async embedBatch(contents, taskType, retried = false) {
        try {
            const res = await this.ai.models.embedContent({
                model: EMBED_MODEL,
                contents,
                config: { taskType, outputDimensionality: EMBED_DIMS },
            });
            return (res.embeddings ?? []).map((e) => e.values);
        }
        catch (err) {
            if (!retried) {
                await new Promise((r) => setTimeout(r, 1500)); // back off once on 429/transient
                return this.embedBatch(contents, taskType, true);
            }
            throw err;
        }
    }
}
exports.Embedder = Embedder;
/** Cosine similarity. Inputs need not be normalized. */
function cosineSim(a, b) {
    let dot = 0, na = 0, nb = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
//# sourceMappingURL=embeddings.js.map