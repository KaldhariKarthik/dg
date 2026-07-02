/**
 * src/recall/openaiEmbeddings.ts — OpenAI embeddings, drop-in for the Gemini
 * Embedder. Same surface (embedDocuments / embedQuery) so RecallService never
 * knows which vendor produced the vectors.
 *
 * Model: text-embedding-3-small ($0.02 / 1M tokens — ~the cheapest credible
 * option, and 5x cheaper than ada-002). It supports Matryoshka dimension
 * reduction via the `dimensions` param, so we keep the project's existing 768
 * dims (set EMBED_DIMS to change). text-embedding-3 has no document/query task
 * asymmetry, so unlike Gemini we embed both sides the same way — simpler and
 * correct for this model family.
 *
 * Vectors are NOT pre-normalized by the dimensions-reduced endpoint, so callers
 * keep using cosine similarity (re-exported here for a single import site).
 */
import OpenAI from "openai";
export { cosineSim, chunkText } from "./embeddings";

const EMBED_MODEL = (process.env.EMBED_MODEL ?? "text-embedding-3-small").trim();
const EMBED_DIMS = Number(process.env.EMBED_DIMS ?? 768);
const BATCH = 256; // OpenAI allows up to 2048 inputs/request; stay comfortably under.

export class OpenAIEmbedder {
    private client: OpenAI;
    constructor(apiKey: string) {
        if (!apiKey) throw new Error("OpenAIEmbedder: missing apiKey");
        this.client = new OpenAI({ apiKey });
    }

    /** Embed many document chunks. Batched to keep requests small. */
    async embedDocuments(texts: string[]): Promise<number[][]> {
        const out: number[][] = [];
        for (let i = 0; i < texts.length; i += BATCH) {
            const slice = texts.slice(i, i + BATCH);
            out.push(...(await this.embedBatch(slice)));
        }
        return out;
    }

    /** Embed a single search query. */
    async embedQuery(text: string): Promise<number[]> {
        const [v] = await this.embedBatch([text]);
        return v ?? [];
    }

    private async embedBatch(input: string[], retried = false): Promise<number[][]> {
        try {
            const res = await this.client.embeddings.create({
                model: EMBED_MODEL,
                input,
                dimensions: EMBED_DIMS,
            });
            // API returns items with an `index`; sort to guarantee input order.
            return res.data
                .slice()
                .sort((a, b) => a.index - b.index)
                .map((d) => d.embedding as number[]);
        } catch (err) {
            if (!retried) {
                await new Promise((r) => setTimeout(r, 1500)); // back off once on 429/transient
                return this.embedBatch(input, true);
            }
            throw err;
        }
    }
}
