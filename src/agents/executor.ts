/**
 * src/agents/executor.ts — REAL executor (Gmail + Calendar), AUTO mode.
 *
 * EMAIL: from a single prompt, the LLM composes the full email (subject+body)
 * faithfully following the user's instruction, shows the finished draft, and
 * only asks yes/no before sending. Supports MULTIPLE recipients. The only
 * thing it ever asks for is a recipient address, and only if none was given.
 *
 * CALENDAR: from a prompt like "add lunch with Sam tomorrow 1pm for an hour",
 * the LLM extracts the event, shows it, and on yes creates it on the user's
 * primary Google Calendar.
 *
 * Cross-turn state lives in ctx.state (emailDraft / eventDraft), persisted by
 * the Store, since the orchestrator runs one turn then finishes. Adapters are
 * injected; this file never imports googleapis.
 */

import {
    Agent,
    AgentRequest,
    AgentResponse,
    Context,
    CONTRACT_VERSION,
} from "../core/types";
import { LLMProvider } from "../llm/provider";
import {
    GmailAdapter,
    EmailDraft,
    CalendarAdapter,
    CalendarEvent,
    CalendarEventPatch,
} from "../adapters/adapter";
import { NotConnectedError } from "../adapters/google-auth";

export type GmailAdapterFactory = (sessionId: string) => GmailAdapter;
export type CalendarAdapterFactory = (sessionId: string) => CalendarAdapter;

/* ============================ EMAIL state ============================== */
type EmailStage = "need_recipient" | "confirming";
interface PersistedEmailDraft {
    kind: "email";
    stage: EmailStage;
    to: string[];            // <-- now a LIST
    subject: string | null;
    body: string | null;
    instruction: string;
}
const EMAIL_KEY = "emailDraft";

/* ============================ CALENDAR state ========================== */
type EventStage = "confirming";
interface PersistedEventDraft {
    kind: "event";
    stage: EventStage;
    summary: string;
    description: string | null;
    location: string | null;
    start: string;           // ISO 8601
    end: string;             // ISO 8601
    attendees: string[];
    instruction: string;
}
const EVENT_KEY = "eventDraft";

/**
 * Short-term memory of the LAST event we successfully created this session, so
 * follow-ups like "also invite X" or "move it to 4pm" can target it. Holds the
 * full current state of the event plus its Google id.
 */
interface LastEvent {
    id: string;
    summary: string;
    description: string | null;
    location: string | null;
    start: string;
    end: string;
    attendees: string[];
}
const LAST_EVENT_KEY = "lastEvent";

/**
 * An in-flight EDIT to the last created event, awaiting yes/no. We keep the
 * target id, the proposed patch, and a human-readable summary of the change.
 */
interface PersistedEventEdit {
    kind: "eventEdit";
    eventId: string;
    /** The merged "after" view, for display + to refresh lastEvent on success. */
    after: LastEvent;
    /** Only the fields that actually change (sent to the adapter). */
    patch: CalendarEventPatch;
    changeSummary: string;
}
const EVENT_EDIT_KEY = "eventEdit";

interface Composed { subject: string; body: string; }

export class ExecutorAgent implements Agent {
    readonly name = "executor" as const;

    constructor(
        private llm: LLMProvider,
        private gmailFactory: GmailAdapterFactory,
        private calendarFactory: CalendarAdapterFactory
    ) { }

    async handle(req: AgentRequest, ctx: Context): Promise<AgentResponse> {
        const userText =
            req.input.kind === "text" ? req.input.text : req.input.text ?? "";

        // ---- Resume an open EMAIL draft ----------------------------------
        const email = this.readEmail(ctx);
        if (email) return this.resumeEmail(email, userText, ctx);

        // ---- Resume an open EVENT draft ----------------------------------
        const event = this.readEvent(ctx);
        if (event) return this.resumeEvent(event, userText, ctx);

        // ---- Resume an open EVENT EDIT (awaiting yes/no) -----------------
        const edit = this.readEventEdit(ctx);
        if (edit) return this.resumeEventEdit(edit, userText, ctx);

        // ---- Maybe this message edits the LAST created event -------------
        // e.g. "also invite X", "move it to 4pm", "rename it to Standup".
        // Only consider this if we have a remembered event and the message
        // looks like a modification rather than a brand-new request.
        const last = this.readLastEvent(ctx);
        if (last && this.looksLikeEdit(userText)) {
            const proposed = await this.proposeEdit(last, userText);
            if (proposed) return this.confirmEventEdit(proposed);
            // If we couldn't build a patch, fall through to normal handling.
        }

        // ---- Fresh message: classify which action --------------------------
        const action = await this.classifyAction(userText);
        if (action === "send_email") return this.startEmail(userText);
        if (action === "create_event") return this.startEvent(userText, ctx);

        return this.reply(
            "I can send emails and add calendar events for you. Try:\n" +
            '• "email john@x.com and sara@y.com saying the demo is ready"\n' +
            '• "add a meeting with the team Friday 3pm for 30 min"'
        );
    }

    /* =================================================================== *
     *  EMAIL
     * =================================================================== */
    private async startEmail(userText: string): Promise<AgentResponse> {
        const intent = await this.interpretEmail(userText);
        const base: PersistedEmailDraft = {
            kind: "email",
            stage: "need_recipient",
            to: intent.to,
            subject: null,
            body: null,
            instruction: intent.instruction || userText,
        };
        if (base.to.length === 0) {
            return this.reply("Sure — who should I send it to? (one or more email addresses)", {
                [EMAIL_KEY]: base,
            });
        }
        return this.composeAndConfirm(base, base.instruction);
    }

    private async resumeEmail(
        draft: PersistedEmailDraft,
        userText: string,
        ctx: Context
    ): Promise<AgentResponse> {
        const reply = this.classifyReply(userText);
        if (reply === "cancel") {
            return this.reply("Okay, I've discarded that email draft.", { [EMAIL_KEY]: null });
        }
        if (draft.stage === "need_recipient") {
            const addrs = this.extractEmails(userText);
            if (addrs.length === 0) {
                return this.reply("I just need a valid email address (or several) to send to.", {
                    [EMAIL_KEY]: draft,
                });
            }
            return this.composeAndConfirm({ ...draft, to: addrs }, draft.instruction);
        }
        // confirming
        if (reply === "confirm") return this.sendEmail(draft, ctx);
        // feedback -> recompose
        return this.composeAndConfirm(
            draft,
            `${draft.instruction}\n\nRevision request from the user: ${userText}`
        );
    }

    private async composeAndConfirm(
        draft: PersistedEmailDraft,
        instruction: string
    ): Promise<AgentResponse> {
        let composed: Composed | null = null;
        try {
            composed = await this.composeEmail(instruction, draft.to);
        } catch {
            composed = null;
        }
        if (!composed) composed = { subject: "(no subject)", body: instruction };

        const next: PersistedEmailDraft = {
            ...draft,
            stage: "confirming",
            subject: composed.subject,
            body: composed.body,
            instruction,
        };
        return this.reply(
            `Here's the email I drafted:\n\n` +
            `To: ${next.to.join(", ")}\n` +
            `Subject: ${next.subject}\n\n` +
            `${next.body}\n\n` +
            `Send it? (yes / no — or tell me what to change)`,
            { [EMAIL_KEY]: next }
        );
    }

    private async sendEmail(
        draft: PersistedEmailDraft,
        ctx: Context
    ): Promise<AgentResponse> {
        if (draft.to.length === 0 || !draft.subject || draft.body === null) {
            return this.composeAndConfirm(draft, draft.instruction);
        }
        const email: EmailDraft = {
            to: draft.to.join(", "),       // RFC 822 allows comma-separated
            subject: draft.subject,
            body: draft.body,
        };
        try {
            const result = await this.gmailFactory(ctx.sessionId).send(email);
            return {
                contractVersion: CONTRACT_VERSION,
                from: this.name,
                status: "ok",
                message: `Sent! Your email to ${draft.to.join(", ")} is on its way.`,
                data: { action: "send_email", performed: true, messageId: result.id },
                stateDelta: { [EMAIL_KEY]: null },
            };
        } catch (err) {
            return this.adapterError(err, "send this email", { [EMAIL_KEY]: undefined });
        }
    }

    private async interpretEmail(
        userText: string
    ): Promise<{ to: string[]; instruction: string }> {
        const system =
            "Extract email send details. Return STRICT JSON only, no markdown:\n" +
            '{"to":[<every email address that appears, as strings>],' +
            '"instruction":<faithful summary of what the user wants the email to ' +
            'SAY — preserve their actual message/content, do not generalize>}\n' +
            "If no address appears, use an empty array for `to`.";
        try {
            const raw = await this.llm.complete(
                [{ role: "system", content: system }, { role: "user", content: userText }],
                { temperature: 0 }
            );
            const o = this.parseJson(raw);
            if (o) {
                const to = Array.isArray(o.to)
                    ? (o.to as unknown[]).flatMap((x) =>
                        typeof x === "string" ? this.extractEmails(x) : []
                    )
                    : [];
                const instruction =
                    typeof o.instruction === "string" && o.instruction.trim()
                        ? o.instruction.trim()
                        : userText;
                // Union with a raw regex sweep so we never miss an address.
                const all = Array.from(new Set([...to, ...this.extractEmails(userText)]));
                return { to: all, instruction };
            }
        } catch {
            /* fall through */
        }
        return { to: this.extractEmails(userText), instruction: userText };
    }

    private async composeEmail(instruction: string, to: string[]): Promise<Composed | null> {
        const system =
            "You write an email on the user's behalf. FOLLOW THE INSTRUCTION " +
            "FAITHFULLY — the email's content must convey exactly what the user " +
            "asked to communicate; do not replace it with a generic message. Keep " +
            "a natural, appropriate tone, concise unless asked otherwise. Use a " +
            "generic greeting if no name is known, and a generic sign-off (e.g. " +
            "'Best,') without inventing a sender name.\n\n" +
            "Return STRICT JSON only, no markdown:\n" +
            '{"subject":"<concise subject reflecting the content>",' +
            '"body":"<full body, \\n for line breaks>"}';
        const user =
            `Recipient(s): ${to.join(", ") || "(unknown)"}\n` +
            `Instruction (what the email must say): ${instruction}\n\n` +
            "Write the email now as JSON.";
        const raw = await this.llm.complete(
            [{ role: "system", content: system }, { role: "user", content: user }],
            { temperature: 0.4 }
        );
        const o = this.parseJson(raw);
        if (!o) return null;
        const subject =
            typeof o.subject === "string" && o.subject.trim() ? o.subject.trim() : null;
        const body = typeof o.body === "string" && o.body.trim() ? o.body : null;
        if (!subject || body === null) return null;
        return { subject, body };
    }

    /* =================================================================== *
     *  CALENDAR
     * =================================================================== */
    private async startEvent(userText: string, ctx: Context): Promise<AgentResponse> {
        const nowIso = new Date().toISOString();
        const ev = await this.interpretEvent(userText, nowIso);
        if (!ev) {
            return this.reply(
                "I couldn't work out the event details. Try including a time, " +
                'e.g. "add lunch with Sam tomorrow at 1pm for an hour".'
            );
        }
        const draft: PersistedEventDraft = {
            kind: "event",
            stage: "confirming",
            ...ev,
            instruction: userText,
        };
        return this.confirmEvent(draft);
    }

    private async resumeEvent(
        draft: PersistedEventDraft,
        userText: string,
        ctx: Context
    ): Promise<AgentResponse> {
        const reply = this.classifyReply(userText);
        if (reply === "cancel") {
            return this.reply("Okay, I won't add that event.", { [EVENT_KEY]: null });
        }
        if (reply === "confirm") return this.createEvent(draft, ctx);
        // feedback -> re-extract using original + revision
        const nowIso = new Date().toISOString();
        const ev = await this.interpretEvent(
            `${draft.instruction}\n\nRevision: ${userText}`,
            nowIso
        );
        if (!ev) return this.confirmEvent(draft); // keep old if reparse failed
        return this.confirmEvent({ ...draft, ...ev, instruction: draft.instruction });
    }

    private confirmEvent(draft: PersistedEventDraft): AgentResponse {
        const when = this.formatRange(draft.start, draft.end);
        const lines = [
            `Here's the event I'll add:`,
            ``,
            `Title: ${draft.summary}`,
            `When: ${when}`,
        ];
        if (draft.location) lines.push(`Where: ${draft.location}`);
        if (draft.attendees.length) lines.push(`Guests: ${draft.attendees.join(", ")}`);
        if (draft.description) lines.push(`Notes: ${draft.description}`);
        lines.push(``, `Add it? (yes / no — or tell me what to change)`);
        return this.reply(lines.join("\n"), { [EVENT_KEY]: draft });
    }

    private async createEvent(
        draft: PersistedEventDraft,
        ctx: Context
    ): Promise<AgentResponse> {
        const event: CalendarEvent = {
            summary: draft.summary,
            description: draft.description ?? undefined,
            location: draft.location ?? undefined,
            start: draft.start,
            end: draft.end,
            attendees: draft.attendees,
        };
        try {
            const result = await this.calendarFactory(ctx.sessionId).createEvent(event);
            const link = result.htmlLink ? `\n${result.htmlLink}` : "";
            const last: LastEvent = {
                id: result.id,
                summary: draft.summary,
                description: draft.description,
                location: draft.location,
                start: draft.start,
                end: draft.end,
                attendees: draft.attendees,
            };
            return {
                contractVersion: CONTRACT_VERSION,
                from: this.name,
                status: "ok",
                message: `Added "${draft.summary}" to your calendar.${link}`,
                data: { action: "create_event", performed: true, eventId: result.id },
                // Clear the draft AND remember this event for follow-up edits.
                stateDelta: { [EVENT_KEY]: null, [LAST_EVENT_KEY]: last },
            };
        } catch (err) {
            return this.adapterError(err, "add this event", { [EVENT_KEY]: undefined });
        }
    }

    /* ------------------------------------------------------------------ *
     *  EDIT the last created event.
     * ------------------------------------------------------------------ */

    /** Cheap pre-filter: does this read like a tweak to an existing event? */
    private looksLikeEdit(text: string): boolean {
        const t = text.trim().toLowerCase();
        return (
            /\b(also|too|as well)\b/.test(t) ||
            /\b(invite|add|remove|change|move|reschedule|rename|update|make it|set it|push it|shift)\b/.test(t) ||
            /\b(it|that|the meeting|the event|this meeting|this event)\b/.test(t)
        );
    }

    /** Ask the LLM for a patch against the last event. Returns an edit draft. */
    private async proposeEdit(
        last: LastEvent,
        userText: string
    ): Promise<PersistedEventEdit | null> {
        const nowIso = new Date().toISOString();
        const system =
            "The user wants to MODIFY an existing calendar event. You are given " +
            "the event's CURRENT state and the user's change request. Decide if " +
            "this is genuinely an edit to THIS event (vs an unrelated new request). " +
            `Current time is ${nowIso}; resolve relative times to ISO 8601 with the ` +
            "same offset.\n\n" +
            "Return STRICT JSON only, no markdown:\n" +
            '{"isEdit":true|false,' +
            '"patch":{"summary"?:string,"description"?:string,"location"?:string,' +
            '"start"?:string,"end"?:string,"attendees"?:[string,...]},' +
            '"changeSummary":"<one-line human description of the change>"}\n\n' +
            "Rules:\n" +
            "- Only include fields in `patch` that actually change.\n" +
            "- For adding/removing guests, return the FULL new attendee list in " +
            "`attendees` (current list is given so you can add to it).\n" +
            "- If it's not an edit to this event, set isEdit=false.";
        const user =
            `Current event:\n${JSON.stringify(
                {
                    summary: last.summary,
                    description: last.description,
                    location: last.location,
                    start: last.start,
                    end: last.end,
                    attendees: last.attendees,
                },
                null,
                2
            )}\n\nChange request: ${userText}`;

        let o: Record<string, unknown> | null;
        try {
            const raw = await this.llm.complete(
                [{ role: "system", content: system }, { role: "user", content: user }],
                { temperature: 0 }
            );
            o = this.parseJson(raw);
        } catch {
            return null;
        }
        if (!o || o.isEdit !== true || typeof o.patch !== "object" || o.patch === null) {
            return null;
        }

        const p = o.patch as Record<string, unknown>;
        const patch: CalendarEventPatch = {};
        if (typeof p.summary === "string") patch.summary = p.summary;
        if (typeof p.description === "string") patch.description = p.description;
        if (typeof p.location === "string") patch.location = p.location;
        if (typeof p.start === "string") patch.start = p.start;
        if (typeof p.end === "string") patch.end = p.end;
        if (Array.isArray(p.attendees)) {
            patch.attendees = (p.attendees as unknown[]).flatMap((x) =>
                typeof x === "string" ? this.extractEmails(x) : []
            );
        }
        if (Object.keys(patch).length === 0) return null;

        const after: LastEvent = {
            id: last.id,
            summary: patch.summary ?? last.summary,
            description: patch.description ?? last.description,
            location: patch.location ?? last.location,
            start: patch.start ?? last.start,
            end: patch.end ?? last.end,
            attendees: patch.attendees ?? last.attendees,
        };
        const changeSummary =
            typeof o.changeSummary === "string" && o.changeSummary.trim()
                ? o.changeSummary.trim()
                : "update the event";

        return {
            kind: "eventEdit",
            eventId: last.id,
            after,
            patch,
            changeSummary,
        };
    }

    private confirmEventEdit(edit: PersistedEventEdit): AgentResponse {
        const a = edit.after;
        const when = this.formatRange(a.start, a.end);
        const lines = [
            `I'll update the event — ${edit.changeSummary}.`,
            ``,
            `Title: ${a.summary}`,
            `When: ${when}`,
        ];
        if (a.location) lines.push(`Where: ${a.location}`);
        if (a.attendees.length) lines.push(`Guests: ${a.attendees.join(", ")}`);
        if (a.description) lines.push(`Notes: ${a.description}`);
        lines.push(``, `Apply this change? (yes / no)`);
        return this.reply(lines.join("\n"), { [EVENT_EDIT_KEY]: edit });
    }

    private async resumeEventEdit(
        edit: PersistedEventEdit,
        userText: string,
        ctx: Context
    ): Promise<AgentResponse> {
        const reply = this.classifyReply(userText);
        if (reply === "cancel") {
            return this.reply("Okay, I left the event unchanged.", {
                [EVENT_EDIT_KEY]: null,
            });
        }
        if (reply !== "confirm") {
            // Treat as a revised edit request against the SAME last event.
            const last = this.readLastEvent(ctx);
            if (last) {
                const proposed = await this.proposeEdit(last, userText);
                if (proposed) return this.confirmEventEdit(proposed);
            }
            return this.reply(
                'Say "yes" to apply the change, "no" to cancel, or tell me a ' +
                "different change.",
                { [EVENT_EDIT_KEY]: edit }
            );
        }
        // confirm -> apply patch
        try {
            const result = await this.calendarFactory(ctx.sessionId).updateEvent(
                edit.eventId,
                edit.patch
            );
            const link = result.htmlLink ? `\n${result.htmlLink}` : "";
            return {
                contractVersion: CONTRACT_VERSION,
                from: this.name,
                status: "ok",
                message: `Done — updated "${edit.after.summary}".${link}`,
                data: { action: "update_event", performed: true, eventId: result.id },
                // Refresh lastEvent to the new state; clear the edit draft.
                stateDelta: { [EVENT_EDIT_KEY]: null, [LAST_EVENT_KEY]: edit.after },
            };
        } catch (err) {
            return this.adapterError(err, "update this event", {
                [EVENT_EDIT_KEY]: undefined,
            });
        }
    }

    private async interpretEvent(
        userText: string,
        nowIso: string
    ): Promise<Omit<PersistedEventDraft, "kind" | "stage" | "instruction"> | null> {
        const system =
            "Extract a calendar event from the user's message. The current time " +
            `is ${nowIso} (use it to resolve "tomorrow", "Friday 3pm", etc. into ` +
            "absolute times in the SAME timezone offset as that timestamp). " +
            "Default duration 60 minutes if only a start is given. Return STRICT " +
            "JSON only, no markdown:\n" +
            '{"summary":"<title>","description":<string or null>,' +
            '"location":<string or null>,"start":"<ISO 8601 with offset>",' +
            '"end":"<ISO 8601 with offset>","attendees":[<email strings>]}\n' +
            "If you cannot determine a start time, return null.";
        try {
            const raw = await this.llm.complete(
                [{ role: "system", content: system }, { role: "user", content: userText }],
                { temperature: 0 }
            );
            const cleaned = raw.replace(/```json|```/g, "").trim();
            if (cleaned.toLowerCase() === "null") return null;
            const o = this.parseJson(raw);
            if (!o) return null;
            const summary =
                typeof o.summary === "string" && o.summary.trim()
                    ? o.summary.trim()
                    : "Untitled event";
            const start = typeof o.start === "string" ? o.start : null;
            const end = typeof o.end === "string" ? o.end : null;
            if (!start || !end) return null;
            const attendees = Array.isArray(o.attendees)
                ? (o.attendees as unknown[]).flatMap((x) =>
                    typeof x === "string" ? this.extractEmails(x) : []
                )
                : [];
            return {
                summary,
                description: typeof o.description === "string" ? o.description : null,
                location: typeof o.location === "string" ? o.location : null,
                start,
                end,
                attendees,
            };
        } catch {
            return null;
        }
    }

    /* =================================================================== *
     *  Shared: which action does this fresh message want?
     * =================================================================== */
    private async classifyAction(
        userText: string
    ): Promise<"send_email" | "create_event" | "other"> {
        const system =
            "Classify the user's request for a personal assistant. Return STRICT " +
            'JSON only: {"action":"send_email|create_event|other"}.\n' +
            "- send_email: wants to send/write/compose an email or mail.\n" +
            "- create_event: wants to add/schedule/create a calendar event, " +
            "meeting, reminder, or appointment.\n" +
            "- other: anything else.";
        try {
            const raw = await this.llm.complete(
                [{ role: "system", content: system }, { role: "user", content: userText }],
                { temperature: 0 }
            );
            const o = this.parseJson(raw);
            const a = o?.action;
            if (a === "send_email" || a === "create_event" || a === "other") return a;
        } catch {
            /* fall through to heuristic */
        }
        const t = userText.toLowerCase();
        if (/\b(email|gmail|mail|send)\b/.test(t) || this.extractEmails(userText).length)
            return "send_email";
        if (/\b(calendar|event|meeting|schedule|appointment|remind|reminder)\b/.test(t))
            return "create_event";
        return "other";
    }

    /* =================================================================== *
     *  Helpers
     * =================================================================== */
    private classifyReply(text: string): "confirm" | "cancel" | "other" {
        const t = text.trim().toLowerCase();
        if (/^(y|yes|yep|yeah|yup|send|send it|add it|go ahead|confirm|ok|okay|sure|do it)\b/.test(t))
            return "confirm";
        if (/^(n|no|nope|cancel|stop|discard|don'?t)\b/.test(t)) return "cancel";
        return "other";
    }

    /** Extract ALL email addresses, de-duplicated, order-preserving. */
    private extractEmails(text: string): string[] {
        const matches = text.match(/[^\s,<>@]+@[^\s,<>@]+\.[^\s,<>@]+/g) ?? [];
        return Array.from(new Set(matches));
    }

    private formatRange(startIso: string, endIso: string): string {
        try {
            const s = new Date(startIso);
            const e = new Date(endIso);
            const date = s.toLocaleDateString(undefined, {
                weekday: "short", month: "short", day: "numeric",
            });
            const t = (d: Date) =>
                d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
            return `${date}, ${t(s)} – ${t(e)}`;
        } catch {
            return `${startIso} – ${endIso}`;
        }
    }

    private parseJson(raw: string): Record<string, unknown> | null {
        const cleaned = raw.replace(/```json|```/g, "").trim();
        const start = cleaned.indexOf("{");
        const end = cleaned.lastIndexOf("}");
        if (start === -1 || end === -1 || end < start) return null;
        try {
            const obj = JSON.parse(cleaned.slice(start, end + 1));
            return typeof obj === "object" && obj !== null
                ? (obj as Record<string, unknown>)
                : null;
        } catch {
            return null;
        }
    }

    private adapterError(
        err: unknown,
        actionPhrase: string,
        keepDraft: Record<string, unknown>
    ): AgentResponse {
        if (err instanceof NotConnectedError) {
            return {
                contractVersion: CONTRACT_VERSION,
                from: this.name,
                status: "error",
                message:
                    `I need access to your Google account before I can ${actionPhrase}. ` +
                    'Please connect Google (visit /api/auth/google), then try again — ' +
                    "I've kept your draft.",
                data: { performed: false, reason: "not_connected" },
            };
        }
        const msg = err instanceof Error ? err.message : String(err);
        // Drop the draft on a hard failure so the user isn't stuck in a loop.
        return {
            contractVersion: CONTRACT_VERSION,
            from: this.name,
            status: "error",
            message: `Something went wrong and I couldn't ${actionPhrase}. (${msg})`,
            data: { performed: false },
            stateDelta: keepDraft,
            diagnostics: [`adapter error: ${msg}`],
        };
    }

    private readEmail(ctx: Context): PersistedEmailDraft | null {
        const raw = ctx.state[EMAIL_KEY];
        if (!raw || typeof raw !== "object") return null;
        const d = raw as Record<string, unknown>;
        const to = Array.isArray(d.to)
            ? (d.to as unknown[]).filter((x): x is string => typeof x === "string")
            : typeof d.to === "string"
                ? [d.to]
                : [];
        return {
            kind: "email",
            stage: d.stage === "confirming" ? "confirming" : "need_recipient",
            to,
            subject: typeof d.subject === "string" ? d.subject : null,
            body: typeof d.body === "string" ? d.body : null,
            instruction: typeof d.instruction === "string" ? d.instruction : "",
        };
    }

    private readEvent(ctx: Context): PersistedEventDraft | null {
        const raw = ctx.state[EVENT_KEY];
        if (!raw || typeof raw !== "object") return null;
        const d = raw as Record<string, unknown>;
        if (typeof d.start !== "string" || typeof d.end !== "string") return null;
        const attendees = Array.isArray(d.attendees)
            ? (d.attendees as unknown[]).filter((x): x is string => typeof x === "string")
            : [];
        return {
            kind: "event",
            stage: "confirming",
            summary: typeof d.summary === "string" ? d.summary : "Untitled event",
            description: typeof d.description === "string" ? d.description : null,
            location: typeof d.location === "string" ? d.location : null,
            start: d.start,
            end: d.end,
            attendees,
            instruction: typeof d.instruction === "string" ? d.instruction : "",
        };
    }

    private readLastEvent(ctx: Context): LastEvent | null {
        const raw = ctx.state[LAST_EVENT_KEY];
        if (!raw || typeof raw !== "object") return null;
        const d = raw as Record<string, unknown>;
        if (typeof d.id !== "string" || typeof d.start !== "string" || typeof d.end !== "string")
            return null;
        const attendees = Array.isArray(d.attendees)
            ? (d.attendees as unknown[]).filter((x): x is string => typeof x === "string")
            : [];
        return {
            id: d.id,
            summary: typeof d.summary === "string" ? d.summary : "Untitled event",
            description: typeof d.description === "string" ? d.description : null,
            location: typeof d.location === "string" ? d.location : null,
            start: d.start,
            end: d.end,
            attendees,
        };
    }

    private readEventEdit(ctx: Context): PersistedEventEdit | null {
        const raw = ctx.state[EVENT_EDIT_KEY];
        if (!raw || typeof raw !== "object") return null;
        const d = raw as Record<string, unknown>;
        if (typeof d.eventId !== "string") return null;
        if (!d.after || typeof d.after !== "object") return null;
        if (!d.patch || typeof d.patch !== "object") return null;
        const a = d.after as Record<string, unknown>;
        const attendees = Array.isArray(a.attendees)
            ? (a.attendees as unknown[]).filter((x): x is string => typeof x === "string")
            : [];
        const after: LastEvent = {
            id: typeof a.id === "string" ? a.id : d.eventId,
            summary: typeof a.summary === "string" ? a.summary : "Untitled event",
            description: typeof a.description === "string" ? a.description : null,
            location: typeof a.location === "string" ? a.location : null,
            start: typeof a.start === "string" ? a.start : "",
            end: typeof a.end === "string" ? a.end : "",
            attendees,
        };
        return {
            kind: "eventEdit",
            eventId: d.eventId,
            after,
            patch: d.patch as CalendarEventPatch,
            changeSummary:
                typeof d.changeSummary === "string" ? d.changeSummary : "update the event",
        };
    }

    private reply(
        message: string,
        stateDelta?: Record<string, unknown>
    ): AgentResponse {
        return {
            contractVersion: CONTRACT_VERSION,
            from: this.name,
            status: "ok",
            message,
            ...(stateDelta ? { stateDelta } : {}),
        };
    }
}