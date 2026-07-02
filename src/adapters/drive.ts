/**
 * src/adapters/drive.ts — read-only Drive access for Recall. Lists text-bearing
 * files and returns their text (Workspace docs are exported; plain files are
 * downloaded). Uses the same GoogleAuth.clientFor(id) seam as Gmail/Calendar.
 */
import { google } from "googleapis";
import { GoogleAuth } from "./google-auth";
import { DriveAdapter, DriveFileMeta } from "./adapter";

const EXPORT_MAP: Record<string, string> = {
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

export class GoogleDriveAdapter implements DriveAdapter {
    constructor(private auth: GoogleAuth, private sessionId: string) { }

    private async drive() {
        const authClient = await this.auth.clientFor(this.sessionId);
        return google.drive({ version: "v3", auth: authClient });
    }

    async listDocs(maxResults = 50): Promise<DriveFileMeta[]> {
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
                id: f.id as string,
                name: f.name as string,
                mimeType: f.mimeType ?? "",
                modifiedTime: f.modifiedTime ?? "",
            }));
    }

    async readDoc(fileId: string, mimeType: string): Promise<string> {
        const drive = await this.drive();
        const exportType = EXPORT_MAP[mimeType];
        const res = exportType
            ? await drive.files.export({ fileId, mimeType: exportType }, { responseType: "text" })
            : await drive.files.get({ fileId, alt: "media" }, { responseType: "text" });
        return typeof res.data === "string" ? res.data : String(res.data ?? "");
    }
}