/**
 * src/recall/recall.ts — indexing + search over the user's Drive. sync() diffs
 * Drive against what's indexed (by modifiedTime), embeds only new/changed docs,
 * and prunes deleted ones. search() embeds the query and cosine-ranks chunks.
 */
import { Embedder, chunkText, cosineSim } from "./embeddings";
import { DocumentStore, DocChunk, IndexedDoc, DocSearchHit } from "../store/documentStore";
import { DriveAdapter } from "../adapters/adapter";
import { NotConnectedError } from "../adapters/google-auth";

const MAX_DOC_CHARS = 200_000; // bound cost per doc

export interface SyncResult {
    indexed: number;   // (re)indexed this run
    skipped: number;   // unchanged
    removed: number;   // gone from Drive
    totalDocs: number;
    error?: string;
}

export class RecallService {
    constructor(
        private store: DocumentStore,
        private embedder: Embedder,
        private driveFactory: (userId: string) => DriveAdapter
    ) { }

    async sync(userId: string): Promise<SyncResult> {
        const drive = this.driveFactory(userId);
        let files;
        try {
            files = await drive.listDocs(50);
        } catch (e) {
            if (e instanceof NotConnectedError)
                return { indexed: 0, skipped: 0, removed: 0, totalDocs: 0, error: "Google Drive isn't connected." };
            throw e;
        }

        const already = await this.store.listIndexed(userId);
        const byId = new Map(already.map((d) => [d.docId, d]));
        const liveIds = new Set(files.map((f) => f.id));

        let indexed = 0, skipped = 0, removed = 0;

        for (const d of already) {
            if (!liveIds.has(d.docId)) { await this.store.removeDoc(userId, d.docId); removed++; }
        }

        for (const f of files) {
            const prev = byId.get(f.id);
            if (prev && prev.modifiedTime === f.modifiedTime) { skipped++; continue; }

            let text = "";
            try { text = await drive.readDoc(f.id, f.mimeType); } catch { continue; }
            const pieces = chunkText((text || "").slice(0, MAX_DOC_CHARS));
            if (!pieces.length) { if (prev) await this.store.removeDoc(userId, f.id); continue; }

            const vectors = await this.embedder.embedDocuments(pieces);
            const chunks: DocChunk[] = pieces.map((t, i) => ({
                docId: f.id, docName: f.name, chunkIndex: i, text: t, embedding: vectors[i] ?? [],
            }));
            const meta: IndexedDoc = {
                docId: f.id, docName: f.name, modifiedTime: f.modifiedTime,
                chunkCount: chunks.length, indexedAt: Date.now(),
            };
            await this.store.putDoc(userId, meta, chunks);
            indexed++;
        }
        return { indexed, skipped, removed, totalDocs: files.length };
    }

    async search(userId: string, query: string, topK = 5): Promise<DocSearchHit[]> {
        const q = (query || "").trim();
        if (!q) return [];
        const all = await this.store.allChunks(userId);
        if (!all.length) return [];
        const qVec = await this.embedder.embedQuery(q);
        return all
            .map((c) => ({
                docId: c.docId, docName: c.docName, chunkIndex: c.chunkIndex,
                text: c.text, score: cosineSim(qVec, c.embedding),
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);
    }

    async status(userId: string): Promise<{ docs: number; chunks: number }> {
        const [idx, chunks] = await Promise.all([
            this.store.listIndexed(userId), this.store.allChunks(userId),
        ]);
        return { docs: idx.length, chunks: chunks.length };
    }
}