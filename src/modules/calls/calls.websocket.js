const WebSocket = require("ws");

const callSessionManager = require("./call-session.manager");

function attachCallWebSocketServer(server) {
    const wss = new WebSocket.Server({ noServer: true });

    server.on("upgrade", (request, socket, head) => {
        const url = new URL(request.url || "", "http://localhost");
        const match = url.pathname.match(/^\/api\/voice\/calls\/([^/]+)\/(agent-ws|mobile-ws)$/);

        if (!match) {
            return;
        }

        const sessionId = decodeURIComponent(match[1]);
        const endpointType = match[2];
        const session = callSessionManager.getSession(sessionId);

        if (endpointType === "mobile-ws") {
            const attachMethod = session?.attachMobileWebSocket || session?.attachAgentWebSocket;

            if (!session || typeof attachMethod !== "function") {
                socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
                socket.destroy();
                return;
            }

            wss.handleUpgrade(request, socket, head, (ws) => {
                attachMethod.call(session, ws, {
                    agentId: url.searchParams.get("agent_id") || null,
                });
            });
            return;
        }

        if (!session || typeof session.attachAgentWebSocket !== "function") {
            socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
            socket.destroy();
            return;
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
            session.attachAgentWebSocket(ws, {
                agentId: url.searchParams.get("agent_id") || null,
            });
        });
    });
}

module.exports = {
    attachCallWebSocketServer,
};
