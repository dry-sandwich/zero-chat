let peerConnection;
let dataChannels = []; // Array for group chat connections
let ws;
let roomName;
let isInitiator = false;
let chatMode = "p2p"; // Default mode: P2P or group
let username = generateRandomUsername(); // Random username for P2P

// Crypto utilities for message encryption
async function encryptMessage(message, key) {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    data
  );
  return { iv: Array.from(iv), encrypted: Array.from(new Uint8Array(encrypted)) };
}

async function decryptMessage(encryptedData, key) {
  const decoder = new TextDecoder();
  const iv = new Uint8Array(encryptedData.iv);
  const encrypted = new Uint8Array(encryptedData.encrypted);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    encrypted
  );
  return decoder.decode(decrypted);
}

async function generateKey() {
  return await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

let encryptionKey;

function generateRandomUsername() {
  return "User" + Math.random().toString(36).substring(2, 8);
}

function generateRandomRoomName() {
  return "Room" + Math.random().toString(36).substring(2, 10);
}

function joinRoom() {
  roomName = chatMode === "p2p" ? generateRandomRoomName() : document.getElementById("roomInput").value;
  if (!roomName && chatMode === "group") return alert("Enter a room name for group chat!");

  ws = new WebSocket("wss://silk-meadow-tourmaline.glitch.me/"); // Use local signaling server (update to WSS for production)

  ws.onopen = async () => {
    console.log("[WebSocket] Connected to signaling server");
    encryptionKey = await generateKey();
    ws.send(JSON.stringify({ type: "join", room: roomName, username }));
    setupPeerConnection(true);
  };

  ws.onerror = (error) => console.error("[WebSocket] Error:", error);
  ws.onclose = () => console.warn("[WebSocket] Closed");

  ws.onmessage = async (event) => {
    const message = JSON.parse(event.data);
    console.log("[WebSocket] Received:", message);

    if (message.type === "offer") {
      isInitiator = false;
      setupPeerConnection(false);
      await peerConnection.setRemoteDescription(new RTCSessionDescription(message.offer));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      ws.send(JSON.stringify({ type: "answer", room: roomName, answer, username }));
    }

    if (message.type === "answer") {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(message.answer));
    }

    if (message.type === "candidate" && peerConnection) {
      await peerConnection.addIceCandidate(new RTCIceCandidate(message.candidate));
    }

    if (message.type === "new_peer" && chatMode === "group") {
      setupPeerConnection(true, message.id);
    }
  };
}

function setupPeerConnection(isOfferer, targetId = null) {
  const config = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "turn:asia.relay.metered.ca:443?transport=tcp", username: "3a595dd020d950220fd31d35", credential: "FxnloMmUJJuOG/eX" } // Add TURN for better connectivity
    ]
  };
  peerConnection = new RTCPeerConnection(config);

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      waitForWebSocket(() => {
        ws.send(JSON.stringify({ type: "candidate", room: roomName, candidate: event.candidate, target: targetId }));
      });
    }
  };

  peerConnection.onconnectionstatechange = () => {
    console.log("[WebRTC] Connection state:", peerConnection.connectionState);
    updateConnectionStatus(peerConnection.connectionState);
  };

  if (isOfferer) {
    isInitiator = true;
    console.log("[WebRTC] Creating DataChannel (Initiator)");
    const dataChannel = peerConnection.createDataChannel("chat");
    if (chatMode === "group") dataChannels.push({ dc: dataChannel, target: targetId });
    setupDataChannel(dataChannel);
    waitForWebSocket(() => createOffer(targetId));
  } else {
    peerConnection.ondatachannel = (event) => {
      console.log("[WebRTC] DataChannel received (Receiver)");
      const dataChannel = event.channel;
      if (chatMode === "group") dataChannels.push({ dc: dataChannel, target: null });
      setupDataChannel(dataChannel);
    };
  }
}

async function createOffer(targetId) {
  console.log("[WebRTC] Creating Offer...");
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  ws.send(JSON.stringify({ type: "offer", room: roomName, offer, target: targetId, username }));
}

function setupDataChannel(dataChannel) {
  dataChannel.onopen = () => {
    console.log("[WebRTC] DataChannel Opened!");
    document.getElementById("sendBtn").disabled = false;
  };

  dataChannel.onmessage = async (event) => {
    const encryptedData = JSON.parse(event.data);
    const message = await decryptMessage(encryptedData, encryptionKey);
    console.log("[WebRTC] Message Received:", message);
    displayMessage(message, false);
  };

  dataChannel.onerror = (error) => console.error("[WebRTC] DataChannel Error:", error);
  dataChannel.onclose = () => console.log("[WebRTC] DataChannel Closed.");
}

async function sendMessage() {
  if (chatMode === "p2p" && (!peerConnection || !peerConnection.dataChannel || peerConnection.dataChannel.readyState !== "open")) {
    alert("Connection not ready!");
    return;
  }

  const messageInput = document.getElementById("messageInput");
  const message = `${username}: ${messageInput.value}`;
  const encryptedMessage = await encryptMessage(message, encryptionKey);

  if (chatMode === "p2p") {
    peerConnection.dataChannel.send(JSON.stringify(encryptedMessage));
  } else {
    dataChannels.forEach(({ dc }) => {
      if (dc.readyState === "open") dc.send(JSON.stringify(encryptedMessage));
    });
  }

  displayMessage(message, true);
  messageInput.value = "";
}

function displayMessage(text, isLocal) {
  const div = document.createElement("div");
  div.className = "message " + (isLocal ? "local" : "remote");
  div.textContent = text;
  document.getElementById("messages").appendChild(div);
  document.getElementById("messages").appendChild(document.createElement("div")).className = "clearfix";
}

function updateConnectionStatus(state) {
  const statusElement = document.getElementById("status");
  if (state === "connected") {
    statusElement.textContent = "🟢 Connected";
  } else if (state === "disconnected" || state === "failed" || state === "closed") {
    statusElement.textContent = "🔴 Disconnected";
  }
}

function waitForWebSocket(callback) {
  if (ws.readyState === WebSocket.OPEN) {
    callback();
  } else {
    console.log("[WebSocket] Waiting for connection...");
    setTimeout(() => waitForWebSocket(callback), 100);
  }
}

function switchChatMode() {
  chatMode = chatMode === "p2p" ? "group" : "p2p";
  document.getElementById("modeBtn").textContent = `Switch to ${chatMode === "p2p" ? "Group" : "P2P"} Chat`;
  document.getElementById("roomInput").disabled = chatMode === "p2p";
  if (peerConnection) peerConnection.close();
  dataChannels = [];
  document.getElementById("messages").innerHTML = "";
  document.getElementById("sendBtn").disabled = true;
  username = generateRandomUsername();
  alert(`Switched to ${chatMode.toUpperCase()} mode. Username: ${username}`);
}