"use strict";
/**
 * src/adapters/calendar.ts — the concrete Google Calendar implementor.
 *
 * Reuses the SAME GoogleAuth as Gmail (one Google login, shared scopes), so
 * the user doesn't consent twice. Only this file (+ gmail.ts + google-auth.ts)
 * touches googleapis.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GoogleCalendarAdapter = void 0;
const googleapis_1 = require("googleapis");
class GoogleCalendarAdapter {
    auth;
    sessionId;
    constructor(auth, sessionId) {
        this.auth = auth;
        this.sessionId = sessionId;
    }
    async createEvent(event) {
        const authClient = await this.auth.clientFor(this.sessionId);
        const calendar = googleapis_1.google.calendar({ version: "v3", auth: authClient });
        const res = await calendar.events.insert({
            calendarId: "primary",
            requestBody: {
                summary: event.summary,
                description: event.description,
                location: event.location,
                start: { dateTime: event.start },
                end: { dateTime: event.end },
                ...(event.attendees && event.attendees.length
                    ? { attendees: event.attendees.map((email) => ({ email })) }
                    : {}),
            },
        });
        return {
            id: res.data.id ?? "",
            htmlLink: res.data.htmlLink ?? undefined,
        };
    }
    async updateEvent(eventId, patch) {
        const authClient = await this.auth.clientFor(this.sessionId);
        const calendar = googleapis_1.google.calendar({ version: "v3", auth: authClient });
        // PATCH semantics: only the fields we send are changed.
        const requestBody = {};
        if (patch.summary !== undefined)
            requestBody.summary = patch.summary;
        if (patch.description !== undefined)
            requestBody.description = patch.description;
        if (patch.location !== undefined)
            requestBody.location = patch.location;
        if (patch.start !== undefined)
            requestBody.start = { dateTime: patch.start };
        if (patch.end !== undefined)
            requestBody.end = { dateTime: patch.end };
        if (patch.attendees !== undefined)
            requestBody.attendees = patch.attendees.map((email) => ({ email }));
        const res = await calendar.events.patch({
            calendarId: "primary",
            eventId,
            requestBody,
        });
        return {
            id: res.data.id ?? eventId,
            htmlLink: res.data.htmlLink ?? undefined,
        };
    }
}
exports.GoogleCalendarAdapter = GoogleCalendarAdapter;
//# sourceMappingURL=calendar.js.map