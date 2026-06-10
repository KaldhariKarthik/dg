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
import * as fs from "fs";
import * as path from "path";
import { getFirestore } from "./firebase";

export interface DocChunk {
    docId: string;
    docName: string;
    chunkIndex: number;
    text: string;
    embedding: number[];
}

/** Per source-doc metadata, kept so re-sync can skip unchanged files. */
export interface IndexedDoc {
    docId: string;
    docName: string;
    modifiedTime: string; // RFC3339 from Drive — the diff key
    chunkCount: number;
    indexedAt: number;
}

export interface DocSearchHit {
    docId: string;
    docName: string;
    chunkIndex: number;
    text: string;
    score: number;
}

export interface DocumentStore {
    /** Replace all chunks for one doc (delete-then-insert). */
    putDoc(userId: string, meta: IndexedDoc, chunks: DocChunk[]): Promise<void>;
    /** Remove a doc's chunks + index entry. */
    removeDoc(userId: string, docId: string): Promise<void>;
    /** Indexed-doc metadata for a user (for diffing on sync). */
    listIndexed(userId: string): Promise<IndexedDoc[]>;
    /** Every chunk for a user (search loads these and ranks in memory). */
    allChunks(userId: string): Promise<DocChunk[]>;
    /** Wipe everything for a user. */
    clear(userId: string): Promise<void>;
}

/* ---------------- File backend (dev only) ---------------- */

const DATA_DIR = path.join(process.cwd(), "data", "documents");
interface FileShape { indexed: IndexedDoc[]; chunks: DocChunk[]; }

export class FileDocumentStore implements DocumentStore {
    private file(userId: string): string {
        return path.join(DATA_DIR, `${encodeURIComponent(userId)}.json`);
    }
    private read(userId: string): FileShape {
        try {
            const p = JSON.parse(fs.readFileSync(this.file(userId), "utf8"));
            return { indexed: p.indexed ?? [], chunks: p.chunks ?? [] };
        } catch { return { indexed: [], chunks: [] }; }
    }
    private write(userId: string, data: FileShape): void {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(this.file(userId), JSON.stringify(data), "utf8");
    }
    async putDoc(userId: string, meta: IndexedDoc, chunks: DocChunk[]): Promise<void> {
        const data = this.read(userId);
        data.indexed = data.indexed.filter((d) => d.docId !== meta.docId).concat(meta);
        data.chunks = data.chunks.filter((c) => c.docId !== meta.docId).concat(chunks);
        this.write(userId, data);
    }
    async removeDoc(userId: string, docId: string): Promise<void> {
        const data = this.read(userId);
        data.indexed = data.indexed.filter((d) => d.docId !== docId);
        data.chunks = data.chunks.filter((c) => c.docId !== docId);
        this.write(userId, data);
    }
    async listIndexed(userId: string): Promise<IndexedDoc[]> { return this.read(userId).indexed; }
    async allChunks(userId: string): Promise<DocChunk[]> { return this.read(userId).chunks; }
    async clear(userId: string): Promise<void> { this.write(userId, { indexed: [], chunks: [] }); }
}

/* ---------------- Firestore backend (prod) ---------------- */

type Db = NonNullable<ReturnType<typeof getFirestore>>;

export class FirestoreDocumentStore implements DocumentStore {
    constructor(private db: Db) { }
    private chunks() { return this.db.collection("doc_chunks"); }
    private index() { return this.db.collection("doc_index"); }

    async putDoc(userId: string, meta: IndexedDoc, chunks: DocChunk[]): Promise<void> {
        await this.removeDoc(userId, meta.docId);
        // NOTE: a single doc with >~499 chunks would exceed one batch; fine for
        // typical docs. Split into multiple batches if you index huge files.
        const batch = this.db.batch();
        batch.set(this.index().doc(`${userId}__${meta.docId}`), { userId, ...meta });
        chunks.forEach((c, i) =>
            batch.set(this.chunks().doc(`${userId}__${meta.docId}__${i}`), { userId, ...c })
        );
        await batch.commit();
    }
    async removeDoc(userId: string, docId: string): Promise<void> {
        const [cs, idx] = await Promise.all([
            this.chunks().where("userId", "==", userId).where("docId", "==", docId).get(),
            this.index().where("userId", "==", userId).where("docId", "==", docId).get(),
        ]);
        const batch = this.db.batch();
        cs.forEach((d) => batch.delete(d.ref));
        idx.forEach((d) => batch.delete(d.ref));
        await batch.commit();
    }
    async listIndexed(userId: string): Promise<IndexedDoc[]> {
        const snap = await this.index().where("userId", "==", userId).get();
        return snap.docs.map((d) => { const { userId: _u, ...rest } = d.data() as any; return rest as IndexedDoc; });
    }
    async allChunks(userId: string): Promise<DocChunk[]> {
        const snap = await this.chunks().where("userId", "==", userId).get();
        return snap.docs.map((d) => { const { userId: _u, ...rest } = d.data() as any; return rest as DocChunk; });
    }
    async clear(userId: string): Promise<void> {
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