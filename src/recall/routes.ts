/**
 * src/recall/routes.ts — REST surface for Recall. You pass your existing auth
 * middleware and a getUserId(req) accessor (the same one your /api/plans route
 * uses) so this matches your auth seam without guessing it.
 */
import type { Express, RequestHandler, Request } from "express";
import { RecallService } from "./recall";

export function mountRecallRoutes(
    app: Express,
    requireAuth: RequestHandler,
    recall: RecallService,
    getUserId: (req: Request) => string | null
): void {
    app.post("/api/recall/sync", requireAuth, async (req, res) => {
        const userId = getUserId(req);
        if (!userId) { res.status(401).json({ error: "not authenticated" }); return; }
        try { res.json(await recall.sync(userId)); }
        catch (e) {
            console.error("[recall] sync failed:", e);
            res.status(500).json({ error: e instanceof Error ? e.message : "sync failed" });
        }
    });

    app.get("/api/recall/search", requireAuth, async (req, res) => {
        const userId = getUserId(req);
        if (!userId) { res.status(401).json({ error: "not authenticated" }); return; }
        const q = String(req.query.q ?? "").trim();
        if (!q) { res.json({ hits: [] }); return; }
        try { res.json({ hits: await recall.search(userId, q, Number(req.query.k ?? 5)) }); }
        catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : "search failed" }); }
    });

    app.get("/api/recall/status", requireAuth, async (req, res) => {
        const userId = getUserId(req);
        if (!userId) { res.status(401).json({ error: "not authenticated" }); return; }
        res.json(await recall.status(userId));
    });
}