"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GoogleDriveAdapter = void 0;
/**
 * src/adapters/drive.ts — read-only Drive access for Recall. Lists text-bearing
 * files and returns their text (Workspace docs are exported; plain files are
 * downloaded). Uses the same GoogleAuth.clientFor(id) seam as Gmail/Calendar.
 */
const googleapis_1 = require("googleapis");
const EXPORT_MAP = {
    "application/vnd.google-apps.document": "text/plain",
    "application/vnd.google-apps.spreadsheet": "text/csv",
    "application/vnd.google-apps.presentation": "text/plain",
};
const INDEXABLE = [
    "application/vnd.google-apps.document",
    "application/vnd.google-apps.spreadsheet",
    "application/vnd.google-apps.presentation",
    "text/plain",
    "text/markdown",
];
class GoogleDriveAdapter {
    auth;
    sessionId;
    constructor(auth, sessionId) {
        this.auth = auth;
        this.sessionId = sessionId;
    }
    async drive() {
        const authClient = await this.auth.clientFor(this.sessionId);
        return googleapis_1.google.drive({ version: "v3", auth: authClient });
    }
    async listDocs(maxResults = 50) {
        const drive = await this.drive();
        const mimeQuery = INDEXABLE.map((m) => `mimeType='${m}'`).join(" or ");
        const res = await drive.files.list({
            q: `(${mimeQuery}) and trashed=false`,
            fields: "files(id,name,mimeType,modifiedTime)",
            orderBy: "modifiedTime desc",
            pageSize: Math.min(maxResults, 100),
            spaces: "drive",
        });
        return (res.data.files ?? [])
            .filter((f) => f.id && f.name)
            .map((f) => ({
            id: f.id,
            name: f.name,
            mimeType: f.mimeType ?? "",
            modifiedTime: f.modifiedTime ?? "",
        }));
    }
    async readDoc(fileId, mimeType) {
        const drive = await this.drive();
        const exportType = EXPORT_MAP[mimeType];
        const res = exportType
            ? await drive.files.export({ fileId, mimeType: exportType }, { responseType: "text" })
            : await drive.files.get({ fileId, alt: "media" }, { responseType: "text" });
        return typeof res.data === "string" ? res.data : String(res.data ?? "");
    }
}
exports.GoogleDriveAdapter = GoogleDriveAdapter;
//# sourceMappingURL=drive.js.map