"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RecallService = void 0;
/**
 * src/recall/recall.ts — indexing + search over the user's Drive. sync() diffs
 * Drive against what's indexed (by modifiedTime), embeds only new/changed docs,
 * and prunes deleted ones. search() embeds the query and cosine-ranks chunks.
 */
const embeddings_1 = require("./embeddings");
const google_auth_1 = require("../adapters/google-auth");
const MAX_DOC_CHARS = 200_000; // bound cost per doc
class RecallService {
    store;
    embedder;
    driveFactory;
    constructor(store, embedder, driveFactory) {
        this.store = store;
        this.embedder = embedder;
        this.driveFactory = driveFactory;
    }
    async sync(userId) {
        const drive = this.driveFactory(userId);
        let files;
        try {
            files = await drive.listDocs(50);
        }
        catch (e) {
            if (e instanceof google_auth_1.NotConnectedError)
                return { indexed: 0, skipped: 0, removed: 0, totalDocs: 0, error: "Google Drive isn't connected." };
            throw e;
        }
        const already = await this.store.listIndexed(userId);
        const byId = new Map(already.map((d) => [d.docId, d]));
        const liveIds = new Set(files.map((f) => f.id));
        let indexed = 0, skipped = 0, removed = 0;
        for (const d of already) {
            if (!liveIds.has(d.docId)) {
                await this.store.removeDoc(userId, d.docId);
                removed++;
            }
        }
        for (const f of files) {
            const prev = byId.get(f.id);
            if (prev && prev.modifiedTime === f.modifiedTime) {
                skipped++;
                continue;
            }
            let text = "";
            try {
                text = await drive.readDoc(f.id, f.mimeType);
            }
            catch {
                continue;
            }
            const pieces = (0, embeddings_1.chunkText)((text || "").slice(0, MAX_DOC_CHARS));
            if (!pieces.length) {
                if (prev)
                    await this.store.removeDoc(userId, f.id);
                continue;
            }
            const vectors = await this.embedder.embedDocuments(pieces);
            const chunks = pieces.map((t, i) => ({
                docId: f.id, docName: f.name, chunkIndex: i, text: t, embedding: vectors[i] ?? [],
            }));
            const meta = {
                docId: f.id, docName: f.name, modifiedTime: f.modifiedTime,
                chunkCount: chunks.length, indexedAt: Date.now(),
            };
            await this.store.putDoc(userId, meta, chunks);
            indexed++;
        }
        return { indexed, skipped, removed, totalDocs: files.length };
    }
    async search(userId, query, topK = 5) {
        const q = (query || "").trim();
        if (!q)
            return [];
        const all = await this.store.allChunks(userId);
        if (!all.length)
            return [];
        const qVec = await this.embedder.embedQuery(q);
        return all
            .map((c) => ({
            docId: c.docId, docName: c.docName, chunkIndex: c.chunkIndex,
            text: c.text, score: (0, embeddings_1.cosineSim)(qVec, c.embedding),
        }))
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);
    }
    async status(userId) {
        const [idx, chunks] = await Promise.all([
            this.store.listIndexed(userId), this.store.allChunks(userId),
        ]);
        return { docs: idx.length, chunks: chunks.length };
    }
}
exports.RecallService = RecallService;
//# sourceMappingURL=recall.js.map