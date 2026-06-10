/**
 * src/live/tools.ts — the LIVE TOOL BRIDGE.
 *
 * Declares the functions the live model may call, and runs them DIRECTLY against
 * the existing stores/adapters (never through the Orchestrator — that would add
 * seconds of latency and kill the realtime feel). The model is the planner here:
 * it generates plan content and calls upsert_plan; the server owns id/timestamps.
 *
 * World-touching actions use a strict draft -> commit gate held in this runner's
 * per-session state: compose_email/propose_event only DRAFT; send_email/
 * create_event refuse unless a matching draft exists. The model asks by voice;
 * this enforces it in code.
 */
import { Type, FunctionDeclaration } from "@google/genai";
import { PlanStore, normalizePlan, ProposedPlan } from "../store/planStore";
import { MemoryStore } from "../store/memoryStore";
import { GmailAdapter, CalendarAdapter, CalendarEvent } from "../adapters/adapter";
import { NotConnectedError } from "../adapters/google-auth";

export interface LiveToolDeps {
    plans: PlanStore;
    memory: MemoryStore;
    gmailFactory: (userId: string) => GmailAdapter;
    calendarFactory: (userId: string) => CalendarAdapter;
}

/** Function declarations handed to the Live model in config.tools. */
export const TOOL_DECLARATIONS: FunctionDeclaration[] = [
    { name: "get_plans", description: "List the user's current plans with each step's index and done state. Call this before check_step so you use correct indexes." },
    {
        name: "upsert_plan",
        description: "Create a new plan or update an existing one. To update, pass the exact existing id. You generate the goal and concrete, ordered steps yourself.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                id: { type: Type.STRING, description: "Existing plan id to update; omit to create a new plan." },
                goal: { type: Type.STRING },
                timeframe: { type: Type.STRING, description: "e.g. '2 weeks'." },
                targetDate: { type: Type.STRING, description: "ISO date, optional." },
                steps: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            text: { type: Type.STRING },
                            phase: { type: Type.STRING },
                            done: { type: Type.BOOLEAN },
                        },
                        required: ["text"],
                    },
                },
            },
            required: ["goal", "steps"],
        },
    },
    {
        name: "check_step",
        description: "Mark one step of a plan done (or not). Use only when you can SEE or have been TOLD the step is genuinely complete.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                planId: { type: Type.STRING },
                stepIndex: { type: Type.INTEGER },
                done: { type: Type.BOOLEAN, description: "Defaults to true." },
            },
            required: ["planId", "stepIndex"],
        },
    },
    { name: "recall", description: "Read what you've learned about the user: preferences, patterns, and durable facts." },
    {
        name: "remember",
        description: "Save durable things you learned about the user. Only stable preferences/habits/facts, never one-off task details.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                preferences: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Each as 'key: value'." },
                patterns: { type: Type.ARRAY, items: { type: Type.STRING } },
                facts: { type: Type.ARRAY, items: { type: Type.STRING } },
            },
        },
    },
    {
        name: "compose_email",
        description: "DRAFT an email (does NOT send). Always call this first, read the draft back to the user, and ask them to confirm out loud. Never send without confirmation.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                to: { type: Type.ARRAY, items: { type: Type.STRING } },
                subject: { type: Type.STRING },
                body: { type: Type.STRING },
            },
            required: ["to", "body"],
        },
    },
    { name: "send_email", description: "Send the email you previously drafted with compose_email. Call this ONLY after the user clearly confirms. Takes no arguments — it sends the confirmed draft." },
    {
        name: "propose_event",
        description: "DRAFT a calendar event (does NOT create it). Call this first, confirm with the user, then create_event.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                summary: { type: Type.STRING },
                start: { type: Type.STRING, description: "ISO 8601 with offset." },
                end: { type: Type.STRING, description: "ISO 8601 with offset." },
                location: { type: Type.STRING },
                description: { type: Type.STRING },
                attendees: { type: Type.ARRAY, items: { type: Type.STRING } },
            },
            required: ["summary", "start", "end"],
        },
    },
    { name: "create_event", description: "Create the calendar event you previously drafted with propose_event. ONLY after the user confirms. Takes no arguments." },
];

type Emit = (event: string, data?: unknown) => void;

export class LiveToolRunner {
    private pendingEmail: { to: string[]; subject: string; body: string } | null = null;
    private pendingEvent: CalendarEvent | null = null;

    constructor(private userId: string, private deps: LiveToolDeps, private emit: Emit) { }

    async run(name: string, args: Record<string, any>): Promise<unknown> {
        switch (name) {
            case "get_plans": return this.getPlans();
            case "upsert_plan": return this.upsertPlan(args);
            case "check_step": return this.checkStep(args);
            case "recall": return this.recall();
            case "remember": return this.remember(args);
            case "compose_email": return this.composeEmail(args);
            case "send_email": return this.sendEmail();
            case "propose_event": return this.proposeEvent(args);
            case "create_event": return this.createEvent();
            default: return { error: `unknown tool: ${name}` };
        }
    }

    private async getPlans() {
        const plans = await this.deps.plans.listPlans(this.userId);
        return {
            plans: plans.map((p) => ({
                id: p.id, goal: p.goal, timeframe: p.timeframe ?? null,
                steps: p.steps.map((s, i) => ({ index: i, text: s.text, done: !!s.done, phase: s.phase ?? null })),
            })),
        };
    }

    private async upsertPlan(args: Record<string, any>) {
        const proposed: ProposedPlan = {
            id: typeof args.id === "string" ? args.id : undefined,
            goal: String(args.goal ?? ""),
            timeframe: typeof args.timeframe === "string" ? args.timeframe : undefined,
            targetDate: typeof args.targetDate === "string" ? args.targetDate : undefined,
            steps: Array.isArray(args.steps)
                ? args.steps.map((s: any) => ({ text: String(s?.text ?? ""), done: !!s?.done, ...(s?.phase ? { phase: String(s.phase) } : {}) }))
                : [],
        };
        if (!proposed.goal && !(proposed.steps && proposed.steps.length)) return { error: "a goal or steps are required" };
        const existing = proposed.id ? await this.deps.plans.getPlan(this.userId, proposed.id) : null;
        const normalized = normalizePlan(proposed, existing);
        await this.deps.plans.upsertPlan(this.userId, normalized);
        this.emit("plan_upserted", { planId: normalized.id });
        return { planId: normalized.id, goal: normalized.goal, steps: normalized.steps.length };
    }

    private async checkStep(args: Record<string, any>) {
        const planId = String(args.planId ?? "");
        const stepIndex = Number(args.stepIndex);
        const done = args.done === undefined ? true : !!args.done;
        if (!planId || !Number.isInteger(stepIndex)) return { error: "planId and integer stepIndex required" };
        const updated = await this.deps.plans.setStepDone(this.userId, planId, stepIndex, done);
        if (!updated) return { error: "plan not found" };
        this.emit("step_checked", { planId, stepIndex, done });
        return { ok: true, planId, stepIndex, done };
    }

    private async recall() {
        const m = await this.deps.memory.loadMemory(this.userId);
        return { preferences: m.preferences, patterns: m.past_patterns, facts: m.long_term_facts };
    }

    private async remember(args: Record<string, any>) {
        const preferences: Record<string, string> = {};
        if (Array.isArray(args.preferences)) {
            for (const p of args.preferences) {
                if (typeof p === "string" && p.includes(":")) {
                    const i = p.indexOf(":"); const k = p.slice(0, i).trim(); const v = p.slice(i + 1).trim();
                    if (k && v) preferences[k] = v;
                }
            }
        }
        const delta = {
            preferences,
            past_patterns: Array.isArray(args.patterns) ? args.patterns.filter((x: any) => typeof x === "string") : [],
            long_term_facts: Array.isArray(args.facts) ? args.facts.filter((x: any) => typeof x === "string") : [],
        };
        if (!Object.keys(delta.preferences).length && !delta.past_patterns.length && !delta.long_term_facts.length) {
            return { ok: true, note: "nothing new" };
        }
        await this.deps.memory.mergeMemory(this.userId, delta);
        this.emit("memory_updated", {});
        return { ok: true };
    }

    private async composeEmail(args: Record<string, any>) {
        const to = this.emails(args.to);
        const body = String(args.body ?? "");
        if (!to.length) return { error: "at least one recipient email is required" };
        if (!body) return { error: "an email body is required" };
        this.pendingEmail = { to, subject: String(args.subject ?? "").trim() || "(no subject)", body };
        this.emit("draft_email", this.pendingEmail);
        return { drafted: true, ...this.pendingEmail, note: "Read this back and ask the user to confirm. Call send_email ONLY after they agree." };
    }

    private async sendEmail() {
        if (!this.pendingEmail) return { error: "no draft — call compose_email first and confirm with the user" };
        const d = this.pendingEmail;
        try {
            const r = await this.deps.gmailFactory(this.userId).send({ to: d.to.join(", "), subject: d.subject, body: d.body });
            this.pendingEmail = null;
            this.emit("email_sent", { to: d.to, subject: d.subject, id: r.id });
            return { sent: true, to: d.to, id: r.id };
        } catch (e) { return { error: this.adapterMsg(e, "send the email") }; }
    }

    private async proposeEvent(args: Record<string, any>) {
        const summary = String(args.summary ?? "").trim();
        const start = String(args.start ?? ""); const end = String(args.end ?? "");
        if (!summary || !start || !end) return { error: "summary, start, and end (ISO 8601) required" };
        this.pendingEvent = {
            summary, start, end,
            location: typeof args.location === "string" ? args.location : undefined,
            description: typeof args.description === "string" ? args.description : undefined,
            attendees: this.emails(args.attendees),
        };
        this.emit("draft_event", this.pendingEvent);
        return { drafted: true, ...this.pendingEvent, note: "Confirm with the user, then call create_event only after they agree." };
    }

    private async createEvent() {
        if (!this.pendingEvent) return { error: "no draft — call propose_event first and confirm" };
        const ev = this.pendingEvent;
        try {
            const r = await this.deps.calendarFactory(this.userId).createEvent(ev);
            this.pendingEvent = null;
            this.emit("event_created", { summary: ev.summary, id: r.id, link: r.htmlLink ?? null });
            return { created: true, summary: ev.summary, id: r.id, link: r.htmlLink ?? null };
        } catch (e) { return { error: this.adapterMsg(e, "create the event") }; }
    }

    private emails(v: any): string[] {
        const out: string[] = [];
        const push = (s: string) => { const m = s.match(/[^\s,<>@]+@[^\s,<>@]+\.[^\s,<>@]+/g); if (m) out.push(...m); };
        if (typeof v === "string") push(v);
        else if (Array.isArray(v)) for (const x of v) if (typeof x === "string") push(x);
        return Array.from(new Set(out));
    }
    private adapterMsg(e: unknown, phrase: string): string {
        if (e instanceof NotConnectedError) return `I need Google access before I can ${phrase}. Tell the user to connect Google in settings.`;
        return e instanceof Error ? e.message : String(e);
    }
}