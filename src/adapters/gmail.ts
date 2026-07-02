/**
 * src/adapters/gmail.ts — the concrete Gmail implementor of GmailAdapter.
 *
 * Only this file (+ google-auth.ts) touches googleapis. The executor sees the
 * GmailAdapter interface and nothing more.
 *
 * Per-session: constructed with a GoogleAuth + sessionId, so it sends as
 * whichever user owns that session. That's how multi-user works end to end.
 */

import { google } from "googleapis";
import { GmailAdapter, EmailDraft, SendResult } from "./adapter";
import { GoogleAuth } from "./google-auth";

export class GoogleGmailAdapter implements GmailAdapter {
    constructor(private auth: GoogleAuth, private sessionId: string) { }

    async send(draft: EmailDraft): Promise<SendResult> {
        const authClient = await this.auth.clientFor(this.sessionId);
        const gmail = google.gmail({ version: "v1", auth: authClient });

        const raw = this.buildRawMessage(draft);

        const res = await gmail.users.messages.send({
            userId: "me",
            requestBody: { raw },
        });

        return {
            id: res.data.id ?? "",
            threadId: res.data.threadId ?? undefined,
        };
    }

    /**
     * Build an RFC 2822 message and base64url-encode it, which is what the
     * Gmail API's `raw` field expects.
     *
     * Subject is RFC 2047 encoded so non-ASCII (emoji, accents) survives.
     * Body is sent as UTF-8 plain text.
     */
    private buildRawMessage(draft: EmailDraft): string {
        const headers: string[] = [];
        headers.push(`To: ${draft.to}`);
        if (draft.cc) headers.push(`Cc: ${draft.cc}`);
        if (draft.bcc) headers.push(`Bcc: ${draft.bcc}`);
        headers.push(`Subject: ${this.encodeHeader(draft.subject)}`);
        headers.push("MIME-Version: 1.0");
        headers.push('Content-Type: text/plain; charset="UTF-8"');
        headers.push("Content-Transfer-Encoding: 7bit");

        const message = headers.join("\r\n") + "\r\n\r\n" + draft.body;

        return Buffer.from(message, "utf-8")
            .toString("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");
    }

    /** RFC 2047 encode a header value only if it contains non-ASCII. */
    private encodeHeader(value: string): string {
        // eslint-disable-next-line no-control-regex
        if (/^[\x00-\x7F]*$/.test(value)) return value;
        const b64 = Buffer.from(value, "utf-8").toString("base64");
        return `=?UTF-8?B?${b64}?=`;
    }
}