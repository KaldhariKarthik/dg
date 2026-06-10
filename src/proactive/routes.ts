/**
 * src/proactive/routes.ts — REST surface for the proactive layer.
 *
 *   GET  /api/notifications        (auth) -> the attention feed
 *   POST /api/notifications/read   (auth) -> mark one ({id}) or all ({all:true})
 *   POST /api/proactive/run?job=   (auth) -> run a job for the LOGGED-IN user
 *                                            (testing + "refresh my brief")
 *   POST /api/cron/tick?job=       (X-Cron-Key) -> machine endpoint for Cloud
 *                                            Scheduler; processes body.userIds
 *
 * Auto-enumeration of every user would need a UserStore.listUsers(); until that
 * exists the scheduler passes the userIds to process. The self-trigger route
 * needs none of that — it's the user acting on their own data.
 */
import type { Express, RequestHandler, Request } from "express";
import { ProactiveService } from "./proactive";
import { NotificationStore } from "../store/notificationStore";

async function runJob(p: ProactiveService, job: string, userId: string) {
    if (job === "brief") return { briefed: await p.morningBrief(userId) };
    if (job === "sentinel") return { alerts: await p.runSentinel(userId) };
    return { error: `unknown job "${job}"` };
}

export function mountProactiveRoutes(
    app: Express,
    requireAuth: RequestHandler,
    proactive: ProactiveService,
    notifications: NotificationStore,
    getUserId: (req: Request) => string | null,
    cronKey: string
): void {
    app.get("/api/notifications", requireAuth, async (req, res) => {
        const userId = getUserId(req);
        if (!userId) { res.status(401).json({ error: "not authenticated" }); return; }
        const unreadOnly = req.query.unread === "1";
        res.json({ notifications: await notifications.list(userId, { unreadOnly, limit: 50 }) });
    });

    app.post("/api/notifications/read", requireAuth, async (req, res) => {
        const userId = getUserId(req);
        if (!userId) { res.status(401).json({ error: "not authenticated" }); return; }
        const { id, all } = req.body as { id?: string; all?: boolean };
        if (all) await notifications.markAllRead(userId);
        else if (id) await notifications.markRead(userId, id);
        else { res.status(400).json({ error: "id or all required" }); return; }
        res.json({ ok: true });
    });

    // Run a job for the signed-in user — the easy way to test, and a fine
    // "refresh my day" button later.
    app.post("/api/proactive/run", requireAuth, async (req, res) => {
        const userId = getUserId(req);
        if (!userId) { res.status(401).json({ error: "not authenticated" }); return; }
        try { res.json(await runJob(proactive, String(req.query.job ?? "brief"), userId)); }
        catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : "job failed" }); }
    });

    // Machine endpoint for Cloud Scheduler. Shared-secret guarded (the service is
    // --allow-unauthenticated for the web app, so we gate in code).
    app.post("/api/cron/tick", async (req, res) => {
        if (!cronKey || req.get("X-Cron-Key") !== cronKey) { res.status(401).json({ error: "unauthorized" }); return; }
        const job = String(req.query.job ?? "brief");
        const body = (req.body ?? {}) as { userIds?: string[] };
        const userIds = Array.isArray(body.userIds) ? body.userIds.filter((x) => typeof x === "string") : [];
        if (!userIds.length) {
            res.status(400).json({ error: "pass { userIds: [...] } in the body (auto-enumeration needs UserStore.listUsers())" });
            return;
        }
        const results: Record<string, unknown> = {};
        for (const uid of userIds) {
            try { results[uid] = await runJob(proactive, job, uid); }
            catch (e) { results[uid] = { error: e instanceof Error ? e.message : "failed" }; }
        }
        res.json({ job, results });
    });
}