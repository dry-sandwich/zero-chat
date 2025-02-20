let peerConnection;
let dataChannels = [];
let ws;
let roomName;
let isInitiator = false;
let chatMode = "p2p";
let username;
let messageIdCounter = 0;

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

function joinRoom() {
    username = document.getElementById("usernameInput").value.trim();
    roomName = document.getElementById("roomInput").value.trim();
    if (!username || !roomName) {
        alert("Please enter a username and room name!");
        return;
    }

    ws = new WebSocket("wss://silk-meadow-tourmaline.glitch.me"); // Update with your Glitch URL

    ws.onopen = async () => {
        console.log("[WebSocket] Connected");
        encryptionKey = await generateKey();
        ws.send(JSON.stringify({ type: "join", room: roomName, username }));
        setupPeerConnection(true);
    };

    ws.onerror = (error) => console.error("[WebSocket] Error:", error);
    ws.onclose = () => {
        console.warn("[WebSocket] Closed");
        updateConnectionStatus("disconnected");
    };

    ws.onmessage = async (event) => {
        const message = JSON.parse(event.data);

        if (message.type === "offer") {
            isInitiator = false;
            setupPeerConnection(false);
            await peerConnection.setRemoteDescription(new RTCSessionDescription(message.offer));
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            ws.send(JSON.stringify({ type: "answer", room: roomName, answer, username }));
        } else if (message.type === "answer") {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(message.answer));
        } else if (message.type === "candidate" && peerConnection) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(message.candidate));
        } else if (message.type === "new_peer" && chatMode === "group") {
            setupPeerConnection(true, message.id);
        } else if (message.type === "text" || message.type === "reaction") {
            const decryptedText = await decryptMessage(message.data, encryptionKey);
            displayMessage(message.type, decryptedText, message.id, message.replyTo, false);
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
        updateConnectionStatus(peerConnection.connectionState);
    };

    if (isOfferer) {
        isInitiator = true;
        const dataChannel = peerConnection.createDataChannel("chat");
        if (chatMode === "group") dataChannels.push({ dc: dataChannel, target: targetId });
        setupDataChannel(dataChannel);
        waitForWebSocket(() => createOffer(targetId));
    } else {
        peerConnection.ondatachannel = (event) => {
            const dataChannel = event.channel;
            if (chatMode === "group") dataChannels.push({ dc: dataChannel, target: null });
            setupDataChannel(dataChannel);
        };
    }
}

async function createOffer(targetId) {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    ws.send(JSON.stringify({ type: "offer", room: roomName, offer, target: targetId, username }));
}

function setupDataChannel(dataChannel) {
    dataChannel.onopen = () => {
        document.getElementById("sendBtn").disabled = false;
    };

    dataChannel.onmessage = async (event) => {
        const message = JSON.parse(event.data);
        const decryptedText = await decryptMessage(message.data, encryptionKey);
        displayMessage(message.type, decryptedText, message.id, message.replyTo, false);
    };

    dataChannel.onerror = (error) => console.error("[WebRTC] DataChannel Error:", error);
    dataChannel.onclose = () => console.log("[WebRTC] DataChannel Closed");
}

async function sendMessage() {
    const messageInput = document.getElementById("messageInput");
    let messageText = messageInput.value.trim();
    if (!messageText) return;

    const messageId = `msg-${messageIdCounter++}`;
    let type = "text";
    let replyTo = null;

    if (messageText.startsWith("Replying to:")) {
        const lines = messageText.split("\n");
        replyTo = lines[0].replace("Replying to: ", "");
        messageText = lines.slice(1).join("\n").trim();
    } else if (/^[👍👎😂😊😢]$/.test(messageText)) {
        type = "reaction";
    }

    const message = `${username}: ${messageText}`;
    const encryptedMessage = await encryptMessage(message, encryptionKey);
    const payload = { type, data: encryptedMessage, id: messageId, replyTo };

    if (chatMode === "p2p" && peerConnection?.dataChannel?.readyState === "open") {
        peerConnection.dataChannel.send(JSON.stringify(payload));
    } else if (chatMode === "group") {
        dataChannels.forEach(({ dc }) => {
            if (dc.readyState === "open") dc.send(JSON.stringify(payload));
        });
    }

    displayMessage(type, message, messageId, replyTo, true);
    messageInput.value = "";
}

function displayMessage(type, text, id, replyTo, isLocal) {
    const messagesDiv = document.getElementById("messages");
    const div = document.createElement("div");
    div.className = `message ${isLocal ? "local" : "remote"}`;
    div.id = id;

    if (replyTo) {
        const replySpan = document.createElement("span");
        replySpan.style.fontStyle = "italic";
        replySpan.style.opacity = "0.7";
        replySpan.textContent = `Replying to: ${replyTo}`;
        div.appendChild(replySpan);
        div.appendChild(document.createElement("br"));
    }

    if (type === "text") {
        div.textContent += text;
    } else if (type === "reaction") {
        const targetDiv = document.getElementById(id);
        if (targetDiv) {
            const reactionSpan = document.createElement("span");
            reactionSpan.className = "reaction";
            reactionSpan.textContent = text.split(": ")[1];
            targetDiv.appendChild(reactionSpan);
        }
        return;
    }

    messagesDiv.appendChild(div);
    messagesDiv.appendChild(document.createElement("div")).className = "clearfix";
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function updateConnectionStatus(state) {
    const statusElement = document.getElementById("status");
    statusElement.textContent = state === "connected" ? "🟢 Connected" : "🔴 Disconnected";
}

function waitForWebSocket(callback) {
    if (ws.readyState === WebSocket.OPEN) {
        callback();
    } else {
        setTimeout(() => waitForWebSocket(callback), 100);
    }
}

function switchChatMode() {
    chatMode = chatMode === "p2p" ? "group" : "p2p";
    document.getElementById("modeBtn").textContent = `Switch to ${chatMode === "p2p" ? "Group" : "P2P"} Chat`;
    if (peerConnection) peerConnection.close();
    dataChannels = [];
    document.getElementById("messages").innerHTML = "";
    document.getElementById("sendBtn").disabled = true;
    alert(`Switched to ${chatMode.toUpperCase()} mode`);
}

function toggleTheme() {
    document.body.classList.toggle("dark-mode");
    const btn = document.getElementById("themeToggleBtn");
    btn.textContent = document.body.classList.contains("dark-mode") ? "Light Mode" : "Dark Mode";
}

// Event listeners
document.getElementById("messageInput").addEventListener("keypress", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

document.getElementById("messages").addEventListener("click", (e) => {
    const messageDiv = e.target.closest(".message");
    if (messageDiv) {
        const messageText = messageDiv.textContent.split(": ").slice(1).join(": ").replace(/Replying to: .+/, "").trim();
        document.getElementById("messageInput").value = `Replying to: ${messageText}\n`;
    }
});