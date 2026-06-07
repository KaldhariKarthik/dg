"use strict";
/**
 * src/store/fileStore.ts
 *
 * JSON-file implementation of Store. Each session is one file under ./data/.
 * Zero setup, survives restarts, human-inspectable (just open the file).
 * When you outgrow it, write a new Store implementor and swap it in index/
 * server wiring — this file is the only thing tied to the filesystem.
 */
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
exports.FileStore = void 0;
const fs_1 = require("fs");
const path = __importStar(require("path"));
class FileStore {
    dir;
    constructor(dir = path.join(process.cwd(), "data")) {
        this.dir = dir;
    }
    fileFor(sessionId) {
        // Sanitize so a sessionId can never escape the data dir.
        const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
        return path.join(this.dir, `${safe}.json`);
    }
    async load(sessionId) {
        try {
            const raw = await fs_1.promises.readFile(this.fileFor(sessionId), "utf8");
            const parsed = JSON.parse(raw);
            return typeof parsed === "object" && parsed !== null ? parsed : {};
        }
        catch {
            // Missing file or bad JSON -> treat as a fresh session.
            return {};
        }
    }
    async save(sessionId, state) {
        await fs_1.promises.mkdir(this.dir, { recursive: true });
        await fs_1.promises.writeFile(this.fileFor(sessionId), JSON.stringify(state, null, 2), "utf8");
    }
}
exports.FileStore = FileStore;
//# sourceMappingURL=fileStore.js.map