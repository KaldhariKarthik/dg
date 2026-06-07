/**
 * src/store/fileStore.ts
 *
 * JSON-file implementation of Store. Each session is one file under ./data/.
 * Zero setup, survives restarts, human-inspectable (just open the file).
 * When you outgrow it, write a new Store implementor and swap it in index/
 * server wiring — this file is the only thing tied to the filesystem.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { Store } from "./store";

export class FileStore implements Store {
    constructor(private dir: string = path.join(process.cwd(), "data")) { }

    private fileFor(sessionId: string): string {
        // Sanitize so a sessionId can never escape the data dir.
        const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
        return path.join(this.dir, `${safe}.json`);
    }

    async load(sessionId: string): Promise<Record<string, unknown>> {
        try {
            const raw = await fs.readFile(this.fileFor(sessionId), "utf8");
            const parsed = JSON.parse(raw);
            return typeof parsed === "object" && parsed !== null ? parsed : {};
        } catch {
            // Missing file or bad JSON -> treat as a fresh session.
            return {};
        }
    }

    async save(
        sessionId: string,
        state: Record<string, unknown>
    ): Promise<void> {
        await fs.mkdir(this.dir, { recursive: true });
        await fs.writeFile(
            this.fileFor(sessionId),
            JSON.stringify(state, null, 2),
            "utf8"
        );
    }
}