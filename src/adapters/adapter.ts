/**
 * src/adapters/adapter.ts — THE ADAPTER SEAM.
 *
 * Same idea as llm/provider.ts, but for ACTIONS instead of text generation.
 *
 * The executor performs real-world side effects (send an email, create a
 * calendar event, play a song). Each of those lives behind a small, focused
 * adapter interface. The executor depends on these interfaces — never on
 * googleapis or the Spotify SDK directly. Swap Gmail's implementation, add
 * Calendar, add Spotify = write one new implementor. The executor barely
 * changes; the contract (core/types.ts) never changes.
 *
 * Every adapter is "per user": it is constructed with a way to get that user's
 * credentials (see google-auth.ts). Multi-user falls out for free because the
 * sessionId selects whose tokens are used.
 */

/* ----------------------------------------------------------------------------
 *  GMAIL
 * ------------------------------------------------------------------------- */

export interface EmailDraft {
    to: string;
    subject: string;
    body: string;
    cc?: string;
    bcc?: string;
}

export interface SendResult {
    id: string;        // provider message id
    threadId?: string;
}

export interface GmailAdapter {
    /** Send an email on behalf of the authenticated user. */
    send(draft: EmailDraft): Promise<SendResult>;
}

/* ----------------------------------------------------------------------------
 *  CALENDAR
 * ------------------------------------------------------------------------- */

export interface CalendarEvent {
    summary: string;
    description?: string;
    location?: string;
    /** ISO 8601 datetime with offset, e.g. "2026-06-08T13:00:00+05:30". */
    start: string;
    /** ISO 8601 datetime with offset. */
    end: string;
    attendees?: string[];
}

export interface CalendarCreateResult {
    id: string;
    htmlLink?: string;
}

/** Fields that can be changed on an existing event. All optional. */
export interface CalendarEventPatch {
    summary?: string;
    description?: string;
    location?: string;
    start?: string;
    end?: string;
    /** Full replacement attendee list, if provided. */
    attendees?: string[];
}

export interface CalendarAdapter {
    /** Create an event on the user's primary calendar. */
    createEvent(event: CalendarEvent): Promise<CalendarCreateResult>;
    /** Patch an existing event by id. Only provided fields change. */
    updateEvent(
        eventId: string,
        patch: CalendarEventPatch
    ): Promise<CalendarCreateResult>;
}

/* ----------------------------------------------------------------------------
 *  Future adapters (Spotify, etc.) slot in here with the same shape.
 * ------------------------------------------------------------------------- */