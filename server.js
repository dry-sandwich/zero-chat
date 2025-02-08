const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const rooms = new Map();

wss.on("connection", (ws) => {
  let roomName = null;

  ws.on("message", (message) => {
    const data = JSON.parse(message);

    if (data.type === "join") {
      roomName = data.room;
      if (!rooms.has(roomName)) rooms.set(roomName, new Set());
      rooms.get(roomName).add(ws);
      console.log(`User joined room: ${roomName}`);
    }

    if (["offer", "answer", "candidate"].includes(data.type)) {
      if (roomName && rooms.has(roomName)) {
        for (const peer of rooms.get(roomName)) {
          if (peer !== ws && peer.readyState === WebSocket.OPEN) {
            peer.send(JSON.stringify(data));
          }
        }
      }
    }
  });

  ws.on("close", () => {
    if (roomName && rooms.has(roomName)) {
      rooms.get(roomName).delete(ws);
      if (rooms.get(roomName).size === 0) rooms.delete(roomName);
    }
  });
});

app.get("/", (req, res) => {
  res.send("WebRTC Signaling Server Running!");
});

server.listen(3000, () => {
  console.log("WebSocket server is running on port 3000");
});
