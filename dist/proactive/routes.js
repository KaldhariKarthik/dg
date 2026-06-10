"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mountProactiveRoutes = mountProactiveRoutes;
async function runJob(p, job, userId) {
    if (job === "brief")
        return { briefed: await p.morningBrief(userId) };
    if (job === "sentinel")
        return { alerts: await p.runSentinel(userId) };
    return { error: `unknown job "${job}"` };
}
function mountProactiveRoutes(app, requireAuth, proactive, notifications, getUserId, cronKey) {
    app.get("/api/notifications", requireAuth, async (req, res) => {
        const userId = getUserId(req);
        if (!userId) {
            res.status(401).json({ error: "not authenticated" });
            return;
        }
        const unreadOnly = req.query.unread === "1";
        res.json({ notifications: await notifications.list(userId, { unreadOnly, limit: 50 }) });
    });
    app.post("/api/notifications/read", requireAuth, async (req, res) => {
        const userId = getUserId(req);
        if (!userId) {
            res.status(401).json({ error: "not authenticated" });
            return;
        }
        const { id, all } = req.body;
        if (all)
            await notifications.markAllRead(userId);
        else if (id)
            await notifications.markRead(userId, id);
        else {
            res.status(400).json({ error: "id or all required" });
            return;
        }
        res.json({ ok: true });
    });
    // Run a job for the signed-in user — the easy way to test, and a fine
    // "refresh my day" button later.
    app.post("/api/proactive/run", requireAuth, async (req, res) => {
        const userId = getUserId(req);
        if (!userId) {
            res.status(401).json({ error: "not authenticated" });
            return;
        }
        try {
            res.json(await runJob(proactive, String(req.query.job ?? "brief"), userId));
        }
        catch (e) {
            res.status(500).json({ error: e instanceof Error ? e.message : "job failed" });
        }
    });
    // Machine endpoint for Cloud Scheduler. Shared-secret guarded (the service is
    // --allow-unauthenticated for the web app, so we gate in code).
    app.post("/api/cron/tick", async (req, res) => {
        if (!cronKey || req.get("X-Cron-Key") !== cronKey) {
            res.status(401).json({ error: "unauthorized" });
            return;
        }
        const job = String(req.query.job ?? "brief");
        const body = (req.body ?? {});
        const userIds = Array.isArray(body.userIds) ? body.userIds.filter((x) => typeof x === "string") : [];
        if (!userIds.length) {
            res.status(400).json({ error: "pass { userIds: [...] } in the body (auto-enumeration needs UserStore.listUsers())" });
            return;
        }
        const results = {};
        for (const uid of userIds) {
            try {
                results[uid] = await runJob(proactive, job, uid);
            }
            catch (e) {
                results[uid] = { error: e instanceof Error ? e.message : "failed" };
            }
        }
        res.json({ job, results });
    });
}
//# sourceMappingURL=routes.js.map