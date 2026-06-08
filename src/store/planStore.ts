/**
 * src/store/planStore.ts — the PLANS seam (its own lane, NOT the working bag).
 *
 * Plans used to live inside the opaque working-state blob. The problem: every
 * check-off / delete / planner write did read-WHOLE-bag / modify / write-WHOLE-
 * bag, so two of them (or a check-off racing the orchestrator's end-of-turn
 * working-state save) could clobber each other — last write wins, the other edit
 * silently vanishes.
 *
 * Giving plans their own store fixes that at the root: each operation touches one
 * plan, never the whole bag, so plan writes can't collide with working-state
 * writes at all. On Firestore each plan is its own document, so setStepDone /
 * deletePlan are genuinely atomic (a transaction on a single doc). On the FILE
 * backend it's still a read-modify-write of one JSON file — serially safe for a
 * single user, and the file backend is dev-only. That seam is honest, not hidden.
 *
 * The SERVER owns id + timestamps (see normalizePlan). The planner only proposes
 * a plan's *content*; it can never drift an id or wipe a createdAt.
 */

export interface PlanStep {
    text: string;
    done: boolean;
    phase?: string;
}

export interface Plan {
    id: string;
    goal: string;
    timeframe?: string;
    targetDate?: string;
    steps: PlanStep[];
    createdAt: string;
    updatedAt: string;
}

/** What the planner proposes (server fills in id/timestamps it doesn't supply). */
export type ProposedPlan = Partial<Plan> & { goal?: string; steps?: PlanStep[] };

export interface PlanStore {
    /** All of a user's plans, most-recently-updated first. */
    listPlans(userId: string): Promise<Plan[]>;
    /** One plan by id, or null if absent. */
    getPlan(userId: string, planId: string): Promise<Plan | null>;
    /**
     * Create or replace ONE plan by id. Every other plan is untouched by
     * construction — there is no array to re-emit and therefore nothing to drop.
     */
    upsertPlan(userId: string, plan: Plan): Promise<Plan>;
    /**
     * Flip one step's done flag. Atomic on Firestore (single-doc transaction);
     * serially-safe read-modify-write on file. Returns the updated plan, or null
     * if the plan no longer exists.
     */
    setStepDone(
        userId: string,
        planId: string,
        stepIndex: number,
        done: boolean
    ): Promise<Plan | null>;
    /** Remove one plan. */
    deletePlan(userId: string, planId: string): Promise<void>;
}

/** A url/storage-safe slug derived from a string. */
export function slugify(s: string): string {
    return (
        s
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 48) || "plan"
    );
}

/**
 * Server-owned normalization. The planner proposes content; the SERVER decides
 * id + timestamps:
 *   - on UPDATE (an existing plan is supplied) keep its id and createdAt;
 *   - on CREATE stamp createdAt and derive a slug id from the proposed id/goal;
 *   - updatedAt is always "now".
 * This is exactly why a fumbled generation can't drift an id or erase history.
 */
export function normalizePlan(
    proposed: ProposedPlan,
    existing: Plan | null,
    now: string = new Date().toISOString()
): Plan {
    const steps: PlanStep[] = Array.isArray(proposed.steps)
        ? proposed.steps.map((s) => ({
            text: String(s?.text ?? ""),
            done: Boolean(s?.done),
            ...(s?.phase ? { phase: String(s.phase) } : {}),
        }))
        : existing?.steps ?? [];

    const timeframe = proposed.timeframe ?? existing?.timeframe;
    const targetDate = proposed.targetDate ?? existing?.targetDate;

    return {
        id: existing?.id ?? slugify(proposed.id || proposed.goal || "plan"),
        goal: proposed.goal ?? existing?.goal ?? "",
        ...(timeframe ? { timeframe } : {}),
        ...(targetDate ? { targetDate } : {}),
        steps,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
    };
}