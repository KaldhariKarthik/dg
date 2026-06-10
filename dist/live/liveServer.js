"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.attachLiveServer = attachLiveServer;
const ws_1 = require("ws");
const middleware_1 = require("../auth/middleware");
const liveSession_1 = require("./liveSession");
function attachLiveServer(httpServer, sessions, cfg) {
    const wss = new ws_1.WebSocketServer({ noServer: true });
    httpServer.on("upgrade", (req, socket, head) => {
        if (!(req.url || "").startsWith("/live")) {
            socket.destroy();
            return;
        }
        // readCookie only touches req.headers.cookie, so this shim is safe.
        const sid = (0, middleware_1.readCookie)({ headers: req.headers }, middleware_1.SESSION_COOKIE);
        const reject = () => { try {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        }
        catch { } socket.destroy(); };
        if (!sid)
            return reject();
        sessions.resolve(sid).then((session) => {
            if (!session)
                return reject();
            wss.handleUpgrade(req, socket, head, (ws) => {
                const live = new liveSession_1.LiveSession(ws, session.userId, cfg);
                void live.start();
            });
        }).catch(reject);
    });
    console.log("[live] WebSocket endpoint ready at /live");
}
//# sourceMappingURL=liveServer.js.map