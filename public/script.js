let peerConnection = null; // Reset to null initially
let dataChannels = [];
let ws = null;
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
        { name: "AES-GCM", iv }, key, data
    );
    return { iv: Array.from(iv), encrypted: Array.from(new Uint8Array(encrypted)) };
}

async function decryptMessage(encryptedData, key) {
    const decoder = new TextDecoder();
    const iv = new Uint8Array(encryptedData.iv);
    const encrypted = new Uint8Array(encryptedData.encrypted);
    const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv }, key, encrypted
    );
    return decoder.decode(decrypted);
}

async function generateKey() {
    return await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]
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

    // Close existing WebSocket and peer connections
    if (ws) {
        ws.close();
        ws = null;
    }
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    dataChannels = [];

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
        if (peerConnection) {
            peerConnection.close();
            peerConnection = null;
        }
    };

    ws.onmessage = async (event) => {
        const message = JSON.parse(event.data);
        console.log("[WebSocket] Received:", message);

        if (message.type === "offer" && !peerConnection) {
            isInitiator = false;
            setupPeerConnection(false);
            try {
                await peerConnection.setRemoteDescription(new RTCSessionDescription(message.offer));
                const answer = await peerConnection.createAnswer();
                await peerConnection.setLocalDescription(answer);
                ws.send(JSON.stringify({ type: "answer", room: roomName, answer, username }));
            } catch (e) {
                console.error("[WebRTC] Error setting offer/answer:", e);
            }
        } else if (message.type === "answer" && peerConnection && peerConnection.signalingState !== "stable") {
            try {
                await peerConnection.setRemoteDescription(new RTCSessionDescription(message.answer));
            } catch (e) {
                console.error("[WebRTC] Error setting answer:", e);
            }
        } else if (message.type === "candidate" && peerConnection) {
            try {
                await peerConnection.addIceCandidate(new RTCIceCandidate(message.candidate));
            } catch (e) {
                console.error("[WebRTC] Error adding ICE candidate:", e);
            }
        } else if (message.type === "new_peer" && chatMode === "group" && !peerConnection) {
            setupPeerConnection(true, message.id);
        } else if (message.type === "text" || message.type === "reaction") {
            const decryptedText = await decryptMessage(message.data, encryptionKey);
            displayMessage(message.type, decryptedText, message.id, message.username, false);
        } else if (message.type === "peer_left") {
            // Handle peer disconnection in group mode
            dataChannels = dataChannels.filter(dc => dc.target !== message.id);
            if (chatMode === "group" && dataChannels.length === 0) {
                if (peerConnection) {
                    peerConnection.close();
                    peerConnection = null;
                }
            }
        }
    };
}

function setupPeerConnection(isOfferer, targetId = null) {
    if (peerConnection) {
        peerConnection.close();
    }
    peerConnection = new RTCPeerConnection({ iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "turn:asia.relay.metered.ca:443?transport=tcp", username: "3a595dd020d950220fd31d35", credential: "FxnloMmUJJuOG/eX" } // Add TURN for better connectivity
    ] });

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

    peerConnection.onsignalingstatechange = () => {
        console.log("[WebRTC] Signaling state:", peerConnection.signalingState);
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
    if (!peerConnection || peerConnection.signalingState === "closed") {
        console.error("[WebRTC] Peer connection not ready or closed");
        return;
    }
    try {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        ws.send(JSON.stringify({ type: "offer", room: roomName, offer, target: targetId, username }));
    } catch (e) {
        console.error("[WebRTC] Error creating offer:", e);
    }
}

function setupDataChannel(dataChannel) {
    dataChannel.onopen = () => {
        document.getElementById("sendBtn").disabled = false;
        console.log("[WebRTC] DataChannel opened");
    };

    dataChannel.onmessage = async (event) => {
        const message = JSON.parse(event.data);
        const decryptedText = await decryptMessage(message.data, encryptionKey);
        displayMessage(message.type, decryptedText, message.id, message.username, false);
    };

    dataChannel.onerror = (error) => console.error("[WebRTC] Error:", error);
    dataChannel.onclose = () => {
        console.log("[WebRTC] DataChannel closed");
        if (chatMode === "group") {
            dataChannels = dataChannels.filter(dc => dc.dc !== dataChannel);
            if (dataChannels.length === 0 && peerConnection) {
                peerConnection.close();
                peerConnection = null;
            }
        }
    };
}

async function sendMessage() {
    const messageInput = document.getElementById("messageInput");
    const messageText = messageInput.value.trim();
    if (!messageText) return;

    const messageId = `msg-${messageIdCounter++}`;
    const encryptedMessage = await encryptMessage(messageText, encryptionKey);
    const payload = { type: "text", data: encryptedMessage, id: messageId, username };

    if (chatMode === "p2p" && peerConnection?.dataChannel?.readyState === "open") {
        peerConnection.dataChannel.send(JSON.stringify(payload));
    } else if (chatMode === "group") {
        dataChannels.forEach(({ dc }) => {
            if (dc.readyState === "open") dc.send(JSON.stringify(payload));
        });
    }

    displayMessage("text", messageText, messageId, username, true);
    messageInput.value = "";
}

async function sendReaction(messageId, emoji) {
    const encryptedReaction = await encryptMessage(emoji, encryptionKey);
    const payload = { type: "reaction", data: encryptedReaction, id: messageId, username };

    if (chatMode === "p2p" && peerConnection?.dataChannel?.readyState === "open") {
        peerConnection.dataChannel.send(JSON.stringify(payload));
    } else if (chatMode === "group") {
        dataChannels.forEach(({ dc }) => {
            if (dc.readyState === "open") dc.send(JSON.stringify(payload));
        });
    }

    displayMessage("reaction", emoji, messageId, username, true);
}

function getUserColor(username) {
    let hash = 0;
    for (let i = 0; i < username.length; i++) {
        hash = username.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = hash % 360;
    return `hsl(${hue}, 70%, 60%)`;
}

function displayMessage(type, text, id, sender, isLocal) {
    const messagesDiv = document.getElementById("messages");
    if (type === "text") {
        const wrapper = document.createElement("div");
        wrapper.className = `message-wrapper ${isLocal ? "local" : "remote"}`;

        const userDiv = document.createElement("div");
        userDiv.className = "username";
        userDiv.textContent = sender;

        const messageDiv = document.createElement("div");
        messageDiv.className = "message";
        messageDiv.id = id;
        messageDiv.textContent = text;
        messageDiv.style.backgroundColor = isLocal ? "#6C63FF" : getUserColor(sender);

        wrapper.appendChild(userDiv);
        wrapper.appendChild(messageDiv);
        messagesDiv.appendChild(wrapper);
    } else if (type === "reaction") {
        const targetDiv = document.getElementById(id);
        if (targetDiv) {
            const reactionSpan = document.createElement("span");
            reactionSpan.className = "reaction";
            reactionSpan.textContent = text;
            targetDiv.appendChild(reactionSpan);
        }
    }
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function updateConnectionStatus(state) {
    document.getElementById("status").textContent = state === "connected" ? "🟢" : "🔴";
}

function waitForWebSocket(callback) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        callback();
    } else {
        setTimeout(() => waitForWebSocket(callback), 100);
    }
}

function switchChatMode() {
    chatMode = chatMode === "p2p" ? "group" : "p2p";
    document.getElementById("modeBtn").textContent = chatMode === "p2p" ? "👥" : "👤";
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    dataChannels = [];
    document.getElementById("messages").innerHTML = "";
    document.getElementById("sendBtn").disabled = true;
}

// Event listeners
document.getElementById("messageInput").addEventListener("keypress", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    } else if (e.key === "Enter" && e.shiftKey) {
        e.preventDefault();
        document.getElementById("messageInput").value += "\n";
    }
});

document.getElementById("messages").addEventListener("click", (e) => {
    const messageDiv = e.target.closest(".message");
    if (messageDiv) {
        const existingPicker = document.querySelector(".emoji-picker");
        if (existingPicker) existingPicker.remove();

        const picker = document.createElement("div");
        picker.className = "emoji-picker";
        picker.style.right = messageDiv.classList.contains("local") ? "10px" : "auto";
        picker.style.left = messageDiv.classList.contains("local") ? "auto" : "10px";
        const emojis = ["👍", "👎", "😂", "😊", "😢"];
        emojis.forEach(emoji => {
            const btn = document.createElement("button");
            btn.textContent = emoji;
            btn.style.background = "none";
            btn.style.border = "none";
            btn.style.cursor = "pointer";
            btn.onclick = () => {
                sendReaction(messageDiv.id, emoji);
                picker.remove();
            };
            picker.appendChild(btn);
        });
        messageDiv.appendChild(picker);
    }
});