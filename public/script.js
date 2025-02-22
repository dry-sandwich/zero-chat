let peerConnection = null;
let dataChannels = [];
let ws = null;
let roomName;
let isInitiator = false;
let chatMode = "p2p";
let username;
let messageIdCounter = 0;
let pendingIceCandidates = []; // Buffer for ICE candidates

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

    // Clean up existing connections
    if (ws) {
        ws.close();
        ws = null;
    }
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    dataChannels = [];
    pendingIceCandidates = []; // Clear buffered candidates

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
                while (pendingIceCandidates.length > 0) {
                    const candidate = pendingIceCandidates.shift();
                    await peerConnection.addIceCandidate(candidate);
                    console.log("[WebRTC] Processed buffered ICE candidate");
                }
                const answer = await peerConnection.createAnswer();
                await peerConnection.setLocalDescription(answer);
                ws.send(JSON.stringify({ type: "answer", room: roomName, answer, username, target: message.target }));
            } catch (e) {
                console.error("[WebRTC] Error setting offer/answer:", e);
            }
        } else if (message.type === "answer" && peerConnection && peerConnection.signalingState !== "stable") {
            try {
                await peerConnection.setRemoteDescription(new RTCSessionDescription(message.answer));
                while (pendingIceCandidates.length > 0) {
                    const candidate = pendingIceCandidates.shift();
                    await peerConnection.addIceCandidate(candidate);
                    console.log("[WebRTC] Processed buffered ICE candidate");
                }
            } catch (e) {
                console.error("[WebRTC] Error setting answer:", e);
            }
        } else if (message.type === "candidate" && peerConnection) {
            if (peerConnection.remoteDescription) {
                try {
                    await peerConnection.addIceCandidate(new RTCIceCandidate(message.candidate));
                    console.log("[WebRTC] Added ICE candidate successfully");
                } catch (e) {
                    console.error("[WebRTC] Error adding ICE candidate:", e);
                }
            } else {
                console.log("[WebRTC] Buffering ICE candidate until remote description is set");
                pendingIceCandidates.push(new RTCIceCandidate(message.candidate));
            }
        } else if (message.type === "new_peer" && chatMode === "group" && !peerConnection) {
            setupPeerConnection(true, message.id);
        } else if (message.type === "text" || message.type === "reaction") {
            const decryptedText = await decryptMessage(message.data, encryptionKey);
            displayMessage(message.type, decryptedText, message.id, message.username, false);
        } else if (message.type === "peer_left") {
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
    peerConnection = new RTCPeerConnection({
        iceServers: [
            { urls: "stun:stun.relay.metered.ca:80" },
            { urls: "turn:global.relay.metered.ca:80", username: "3a595dd020d950220fd31d35", credential: "FxnloMmUJJuOG/eX" },
            { urls: "turn:global.relay.metered.ca:80?transport=tcp", username: "3a595dd020d950220fd31d35", credential: "FxnloMmUJJuOG/eX" },
            { urls: "turn:global.relay.metered.ca:443", username: "3a595dd020d950220fd31d35", credential: "FxnloMmUJJuOG/eX" },
            { urls: "turns:global.relay.metered.ca:443?transport=tcp", username: "3a595dd020d950220fd31d35", credential: "FxnloMmUJJuOG/eX" },
        ],
    });

    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            waitForWebSocket(() => {
                ws.send(JSON.stringify({ type: "candidate", room: roomName, candidate: event.candidate, target: targetId }));
            });
        }
    };

    peerConnection.onconnectionstatechange = () => {
        const state = peerConnection.connectionState;
        console.log("[WebRTC] Connection state:", state);
        updateConnectionStatus(state);
        if (state === "connected") {
            console.log("[WebRTC] Data channel should be open now");
        } else if (state === "failed" || state === "disconnected") {
            console.error("[WebRTC] Connection failed or disconnected");
            if (peerConnection) {
                peerConnection.close();
                peerConnection = null;
            }
        }
    };

    peerConnection.onsignalingstatechange = () => {
        console.log("[WebRTC] Signaling state:", peerConnection.signalingState);
    };

    peerConnection.ondatachannel = (event) => {
        const dataChannel = event.channel;
        if (chatMode === "group") dataChannels.push({ dc: dataChannel, target: null });
        setupDataChannel(dataChannel);
    };

    if (isOfferer) {
        isInitiator = true;
        const dataChannel = peerConnection.createDataChannel("chat");
        dataChannels.push({ dc: dataChannel, target: targetId }); // Always add to dataChannels
        setupDataChannel(dataChannel);
        waitForWebSocket(() => createOffer(targetId));
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
        updateConnectionStatus("connected");
    };

    dataChannel.onmessage = async (event) => {
        const message = JSON.parse(event.data);
        const decryptedText = await decryptMessage(message.data, encryptionKey);
        displayMessage(message.type, decryptedText, message.id, message.username, false);
        console.log("[WebRTC] Received message:", decryptedText);
    };

    dataChannel.onerror = (error) => console.error("[WebRTC] Error:", error);
    dataChannel.onclose = () => {
        console.log("[WebRTC] DataChannel closed");
        dataChannels = dataChannels.filter(dc => dc.dc !== dataChannel);
        if (dataChannels.length === 0 && peerConnection) {
            peerConnection.close();
            peerConnection = null;
            updateConnectionStatus("disconnected");
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

    dataChannels.forEach(({ dc }) => {
        if (dc.readyState === "open") dc.send(JSON.stringify(payload));
    });

    displayMessage("text", messageText, messageId, username, true);
    messageInput.value = "";
}

async function sendReaction(messageId, emoji) {
    const encryptedReaction = await encryptMessage(emoji, encryptionKey);
    const payload = { type: "reaction", data: encryptedReaction, id: messageId, username };

    dataChannels.forEach(({ dc }) => {
        if (dc.readyState === "open") dc.send(JSON.stringify(payload));
    });

    displayMessage("reaction", emoji, messageId, username, true);
}

// Rest of the functions (getUserColor, displayMessage, updateConnectionStatus, etc.) remain unchanged
// ...
