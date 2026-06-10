"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProactiveService = void 0;
/**
 * src/proactive/proactive.ts — the proactive brain (per user).
 *
 *   morningBrief(userId): synthesize today's calendar + plan progress + a
 *     looming deadline into ONE warm spoken-style line. Stored as a 'brief'
 *     notification. Skips if today's brief already sits unread.
 *
 *   runSentinel(userId): cheap DETERMINISTIC checks (calendar overlaps; a plan
 *     whose target date is near with steps still open). Each finding -> an
 *     'alert' notification, deduped by a stable key so it never double-posts.
 *
 * No new scopes: calendar-read + plans + memory only. Mail-driven alerts are a
 * later add (needs gmail.readonly).
 */
const crypto_1 = require("crypto");
const google_auth_1 = require("../adapters/google-auth");
const DEADLINE_HORIZON_DAYS = 3;
class ProactiveService {
    notifications;
    plans;
    memory;
    calendarFactory;
    llm;
    constructor(notifications, plans, memory, calendarFactory, llm) {
        this.notifications = notifications;
        this.plans = plans;
        this.memory = memory;
        this.calendarFactory = calendarFactory;
        this.llm = llm;
    }
    id() { return (0, crypto_1.randomBytes)(8).toString("hex"); }
    todayKey() { return new Date().toISOString().slice(0, 10); }
    /** [startOfToday, end of today+daysAhead] in server local time, RFC3339. */
    window(daysAhead = 0) {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const end = new Date();
        end.setHours(23, 59, 59, 999);
        end.setDate(end.getDate() + daysAhead);
        return { timeMin: start.toISOString(), timeMax: end.toISOString() };
    }
    async eventsIn(userId, daysAhead) {
        const { timeMin, timeMax } = this.window(daysAhead);
        try {
            return await this.calendarFactory(userId).listEvents(timeMin, timeMax);
        }
        catch (e) {
            if (e instanceof google_auth_1.NotConnectedError)
                return null;
            throw e;
        }
    }
    // ---- Morning brief --------------------------------------------------
    async morningBrief(userId) {
        const key = `brief:${this.todayKey()}`;
        if (await this.notifications.hasUnreadKey(userId, key))
            return false;
        const [events, plans, mem] = await Promise.all([
            this.eventsIn(userId, 0),
            this.plans.listPlans(userId),
            this.memory.loadMemory(userId),
        ]);
        const hasEvents = !!(events && events.length);
        const hasPlans = plans.length > 0;
        if (!hasEvents && !hasPlans)
            return false; // nothing worth a brief
        const eventLines = (events ?? []).map((e) => `- ${fmtTime(e.start)}: ${e.summary}`).join("\n") || "(nothing on the calendar)";
        const planLines = plans.slice(0, 5).map((p) => {
            const done = p.steps.filter((s) => s.done).length;
            const dl = p.targetDate ? `, due ${p.targetDate.slice(0, 10)}` : "";
            return `- "${p.goal}" (${done}/${p.steps.length} done${dl})`;
        }).join("\n") || "(no active plans)";
        const prefs = Object.entries(mem.preferences ?? {}).map(([k, v]) => `${k}: ${v}`).join("; ") || "none";
        const sys = "You are DaVinci giving the user their morning brief — like a sharp, warm person who " +
            "has glanced at their day for them. Two or three natural spoken sentences, no lists, no " +
            "markdown. Lead with what actually matters today. If a plan deadline is close and steps " +
            "remain, name it plainly. Don't invent anything not given. Never mention being an AI.";
        const user = `Today's events:\n${eventLines}\n\nActive plans:\n${planLines}\n\nKnown preferences: ${prefs}\n\nWrite the brief now.`;
        let body = "";
        try {
            body = (await this.llm.complete([{ role: "system", content: sys }, { role: "user", content: user }], { temperature: 0.5 })).trim();
        }
        catch {
            return false;
        }
        if (!body)
            return false;
        await this.notifications.add(userId, {
            id: this.id(), key, kind: "brief",
            title: "Your day", body, createdAt: Date.now(), read: false,
        });
        return true;
    }
    // ---- Sentinel (deterministic) --------------------------------------
    async runSentinel(userId) {
        let added = 0;
        const [events, plans] = await Promise.all([
            this.eventsIn(userId, 1), // today + tomorrow
            this.plans.listPlans(userId),
        ]);
        if (events === null)
            return 0; // calendar not connected
        // 1) Overlapping events.
        const timed = events
            .filter((e) => e.start && e.end)
            .map((e) => ({ e, s: +new Date(e.start), x: +new Date(e.end) }))
            .sort((a, b) => a.s - b.s);
        for (let i = 0; i < timed.length - 1; i++) {
            const a = timed[i], b = timed[i + 1];
            if (b.s < a.x) { // overlap
                const key = `overlap:${a.e.id}:${b.e.id}`;
                if (await this.add(userId, key, "alert", "Schedule clash", `"${a.e.summary}" and "${b.e.summary}" overlap at ${fmtTime(b.e.start)}.`))
                    added++;
            }
        }
        // 2) Plan deadline at risk.
        const now = Date.now();
        const horizon = now + DEADLINE_HORIZON_DAYS * 86400_000;
        for (const p of plans) {
            if (!p.targetDate)
                continue;
            const due = +new Date(p.targetDate);
            if (isNaN(due) || due < now || due > horizon)
                continue;
            const remaining = p.steps.filter((s) => !s.done).length;
            if (remaining === 0)
                continue;
            const key = `planrisk:${p.id}:${p.targetDate.slice(0, 10)}`;
            if (await this.add(userId, key, "alert", "Deadline coming up", `"${p.goal}" is due ${p.targetDate.slice(0, 10)} with ${remaining} step${remaining > 1 ? "s" : ""} left.`))
                added++;
        }
        return added;
    }
    /** Add an alert only if no unread one with this key already exists. */
    async add(userId, key, kind, title, body) {
        if (await this.notifications.hasUnreadKey(userId, key))
            return false;
        await this.notifications.add(userId, { id: this.id(), key, kind, title, body, createdAt: Date.now(), read: false });
        return true;
    }
}
exports.ProactiveService = ProactiveService;
function fmtTime(iso) {
    if (!iso)
        return "all day";
    const d = new Date(iso);
    if (isNaN(+d))
        return iso;
    // all-day events arrive as YYYY-MM-DD (no time component)
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso))
        return "all day";
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
//# sourceMappingURL=proactive.js.map