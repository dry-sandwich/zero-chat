export default {
    async fetch(req, env) {
        if (req.headers.get("Upgrade") === "websocket") {
            const webSocketPair = new WebSocketPair();
            this.handleWebSocket(webSocketPair[1], env);
            return new Response(null, { status: 101, webSocket: webSocketPair[0] });
        }
        return new Response("WebSocket signaling server is running!", { status: 200 });
    },

    async handleWebSocket(socket, env) {
        socket.accept();
        const roomPeers = new Map();

        socket.addEventListener("message", async (event) => {
            const message = JSON.parse(event.data);

            if (message.type === "join") {
                const room = message.room;
                if (!roomPeers.has(room)) roomPeers.set(room, new Set());
                roomPeers.get(room).add(socket);
                console.log(`User joined room: ${room}`);
                return;
            }

            if (["offer", "answer", "candidate"].includes(message.type)) {
                const room = message.room;
                if (roomPeers.has(room)) {
                    for (const peer of roomPeers.get(room)) {
                        if (peer !== socket && peer.readyState === WebSocket.OPEN) {
                            peer.send(JSON.stringify(message));
                        }
                    }
                }
            }
        });

        socket.addEventListener("close", () => {
            for (const [room, peers] of roomPeers) {
                peers.delete(socket);
                if (peers.size === 0) roomPeers.delete(room);
            }
        });
    }
};
