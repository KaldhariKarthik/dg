"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.slugify = slugify;
exports.normalizePlan = normalizePlan;
/** A url/storage-safe slug derived from a string. */
function slugify(s) {
    return (s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48) || "plan");
}
/**
 * Server-owned normalization. The planner proposes content; the SERVER decides
 * id + timestamps:
 *   - on UPDATE (an existing plan is supplied) keep its id and createdAt;
 *   - on CREATE stamp createdAt and derive a slug id from the proposed id/goal;
 *   - updatedAt is always "now".
 * This is exactly why a fumbled generation can't drift an id or erase history.
 */
function normalizePlan(proposed, existing, now = new Date().toISOString()) {
    const steps = Array.isArray(proposed.steps)
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
//# sourceMappingURL=planStore.js.map