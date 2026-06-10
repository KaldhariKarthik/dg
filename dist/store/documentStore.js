"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.FirestoreDocumentStore = exports.FileDocumentStore = void 0;
/**
 * src/store/documentStore.ts — vector index for Recall.
 *
 * Stores per-user document chunks with their embeddings, plus a light index of
 * which source docs are indexed (for diffing on re-sync). Self-contained
 * backends: File for dev, Firestore for prod — matching the seam in factory.ts.
 * Search is NOT here; the RecallService loads allChunks() and cosine-ranks in
 * memory (fine for hundreds–low-thousands of chunks; Firestore native vector
 * search is the drop-in scaling path later).
 */
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/* ---------------- File backend (dev only) ---------------- */
const DATA_DIR = path.join(process.cwd(), "data", "documents");
class FileDocumentStore {
    file(userId) {
        return path.join(DATA_DIR, `${encodeURIComponent(userId)}.json`);
    }
    read(userId) {
        try {
            const p = JSON.parse(fs.readFileSync(this.file(userId), "utf8"));
            return { indexed: p.indexed ?? [], chunks: p.chunks ?? [] };
        }
        catch {
            return { indexed: [], chunks: [] };
        }
    }
    write(userId, data) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(this.file(userId), JSON.stringify(data), "utf8");
    }
    async putDoc(userId, meta, chunks) {
        const data = this.read(userId);
        data.indexed = data.indexed.filter((d) => d.docId !== meta.docId).concat(meta);
        data.chunks = data.chunks.filter((c) => c.docId !== meta.docId).concat(chunks);
        this.write(userId, data);
    }
    async removeDoc(userId, docId) {
        const data = this.read(userId);
        data.indexed = data.indexed.filter((d) => d.docId !== docId);
        data.chunks = data.chunks.filter((c) => c.docId !== docId);
        this.write(userId, data);
    }
    async listIndexed(userId) { return this.read(userId).indexed; }
    async allChunks(userId) { return this.read(userId).chunks; }
    async clear(userId) { this.write(userId, { indexed: [], chunks: [] }); }
}
exports.FileDocumentStore = FileDocumentStore;
class FirestoreDocumentStore {
    db;
    constructor(db) {
        this.db = db;
    }
    chunks() { return this.db.collection("doc_chunks"); }
    index() { return this.db.collection("doc_index"); }
    async putDoc(userId, meta, chunks) {
        await this.removeDoc(userId, meta.docId);
        // NOTE: a single doc with >~499 chunks would exceed one batch; fine for
        // typical docs. Split into multiple batches if you index huge files.
        const batch = this.db.batch();
        batch.set(this.index().doc(`${userId}__${meta.docId}`), { userId, ...meta });
        chunks.forEach((c, i) => batch.set(this.chunks().doc(`${userId}__${meta.docId}__${i}`), { userId, ...c }));
        await batch.commit();
    }
    async removeDoc(userId, docId) {
        const [cs, idx] = await Promise.all([
            this.chunks().where("userId", "==", userId).where("docId", "==", docId).get(),
            this.index().where("userId", "==", userId).where("docId", "==", docId).get(),
        ]);
        const batch = this.db.batch();
        cs.forEach((d) => batch.delete(d.ref));
        idx.forEach((d) => batch.delete(d.ref));
        await batch.commit();
    }
    async listIndexed(userId) {
        const snap = await this.index().where("userId", "==", userId).get();
        return snap.docs.map((d) => { const { userId: _u, ...rest } = d.data(); return rest; });
    }
    async allChunks(userId) {
        const snap = await this.chunks().where("userId", "==", userId).get();
        return snap.docs.map((d) => { const { userId: _u, ...rest } = d.data(); return rest; });
    }
    async clear(userId) {
        const [cs, idx] = await Promise.all([
            this.chunks().where("userId", "==", userId).get(),
            this.index().where("userId", "==", userId).get(),
        ]);
        const batch = this.db.batch();
        cs.forEach((d) => batch.delete(d.ref));
        idx.forEach((d) => batch.delete(d.ref));
        await batch.commit();
    }
}
exports.FirestoreDocumentStore = FirestoreDocumentStore;
//# sourceMappingURL=documentStore.js.map