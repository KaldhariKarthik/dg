/**
 * src/live/liveServer.ts — attaches a WebSocket server to the existing HTTP
 * server and gates the upgrade with the SAME dv_session cookie the REST routes
 * use (no new auth surface). Each authenticated socket gets its own LiveSession.
 * Path: GET /live (Upgrade: websocket).
 */
import type { Server as HttpServer, IncomingMessage } from "http";
import { WebSocketServer } from "ws";
import type { Request } from "express";
import { SessionStore } from "../auth/stores";
import { readCookie, SESSION_COOKIE } from "../auth/middleware";
import { LiveSession, LiveSessionConfig } from "./liveSession";

export function attachLiveServer(httpServer: HttpServer, sessions: SessionStore, cfg: LiveSessionConfig): void {
    const wss = new WebSocketServer({ noServer: true });

    httpServer.on("upgrade", (req: IncomingMessage, socket, head) => {
        if (!(req.url || "").startsWith("/live")) { socket.destroy(); return; }

        // readCookie only touches req.headers.cookie, so this shim is safe.
        const sid = readCookie({ headers: req.headers } as unknown as Request, SESSION_COOKIE);
        const reject = () => { try { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); } catch { } socket.destroy(); };
        if (!sid) return reject();

        sessions.resolve(sid).then((session) => {
            if (!session) return reject();
            wss.handleUpgrade(req, socket, head, (ws) => {
                const live = new LiveSession(ws, session.userId, cfg);
                void live.start();
            });
        }).catch(reject);
    });

    console.log("[live] WebSocket endpoint ready at /live");
}