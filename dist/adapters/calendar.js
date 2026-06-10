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
    async freeBusy(timeMin, timeMax) {
        const authClient = await this.auth.clientFor(this.sessionId);
        const calendar = googleapis_1.google.calendar({ version: "v3", auth: authClient });
        const res = await calendar.freebusy.query({
            requestBody: { timeMin, timeMax, items: [{ id: "primary" }] },
        });
        const busy = res.data.calendars?.primary?.busy ?? [];
        return busy
            .filter((b) => b.start && b.end)
            .map((b) => ({ start: b.start, end: b.end }));
    }
    async listEvents(timeMin, timeMax, maxResults = 25) {
        const authClient = await this.auth.clientFor(this.sessionId);
        const calendar = googleapis_1.google.calendar({ version: "v3", auth: authClient });
        const res = await calendar.events.list({
            calendarId: "primary",
            timeMin,
            timeMax,
            singleEvents: true, // required so orderBy:startTime is valid + recurrences expand
            orderBy: "startTime",
            maxResults,
        });
        return (res.data.items ?? []).map((e) => ({
            id: e.id ?? "",
            summary: e.summary ?? "(no title)",
            start: e.start?.dateTime ?? e.start?.date ?? null,
            end: e.end?.dateTime ?? e.end?.date ?? null,
            ...(e.location ? { location: e.location } : {}),
        }));
    }
}
exports.GoogleCalendarAdapter = GoogleCalendarAdapter;
//# sourceMappingURL=calendar.js.map