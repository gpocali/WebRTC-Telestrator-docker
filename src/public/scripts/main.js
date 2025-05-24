const webRTCConfig = { "iceServers": [] };
const webRTCConnection = {};

/**
 * The websocket connection to the server
 * @type {WebSocket}
 */
let webSocket = null;

/**
 * The drawing controls
 * @type {DrawingControls}
 */
let drawingControls = null;

/**
 * The WebConnection
 * @type {WebConnection}
 */
let connection = null;
let isConnectionHost = false; // Keep track if the current connection is a host

// Updated function to send structured messages to WebSocket
function sendSignalMessage(type, payload) {
    if (webSocket && webSocket.readyState === WebSocket.OPEN) {
        webSocket.send(JSON.stringify({ type, payload }));
    } else {
        console.error("WebSocket not open. Cannot send message:", { type, payload });
    }
}

function initialize() {
    drawingControls = new DrawingControls();

    const debug = false;
    if (debug) {
        webSocket = new WebSocket(`ws://${location.hostname}:${parseInt(location.port) + 1}`);
        drawingControls.enable(null, webSocket);
    }

    const connectionDiv = document.getElementById("connection");
    const hostButton = document.getElementById("hostButton");
    const joinButton = document.getElementById("joinButton");

    hostButton.addEventListener("click", () => {
        connectionDiv.classList.add("hide");
    isConnectionHost = true;
    connect(true);
    });

    joinButton.addEventListener("click", () => {
        connectionDiv.classList.add("hide");
    isConnectionHost = false;
    connect(false);
    });

    // Event listeners for shape selection buttons
    const drawFreehandButton = document.getElementById("drawFreehand");
    const drawArrowButton = document.getElementById("drawArrow");
    const drawCheckmarkButton = document.getElementById("drawCheckmark");
    const drawXButton = document.getElementById("drawX");

    if (drawFreehandButton) {
        drawFreehandButton.addEventListener("click", () => drawingControls.setShape("freehand"));
    }
    if (drawArrowButton) {
        drawArrowButton.addEventListener("click", () => drawingControls.setShape("arrow"));
    }
    if (drawCheckmarkButton) {
        drawCheckmarkButton.addEventListener("click", () => drawingControls.setShape("checkmark"));
    }
    if (drawXButton) {
        drawXButton.addEventListener("click", () => drawingControls.setShape("x"));
    }
}

/**
 * Connect to the server
 * @param {boolean} asHost 
 */
function connect(asHost) {
    webSocket = new WebSocket(`ws://${location.hostname}:${parseInt(location.port) + 1}`);

    connection = new WebConnection();

    // Listen for "signal" events from WebConnection to send to the server
    connection.addEventListener("signal", (e) => {
        sendSignalMessage(e.detail.type, e.detail.payload);
    });
    
    // Event listener for when host has acquired the stream
    connection.addEventListener("streamacquired", () => {
        if (asHost) {
            console.log("Host stream acquired, declaring host to server.");
            sendSignalMessage("declare_host", { hostId: connection.id }); // connection.id is WebConnection's ID
        }
    });
    
    connection.addEventListener("streamerror", (e) => {
        console.error("Stream acquisition error:", e.detail);
        // Handle UI feedback for stream error, e.g., show connectionDiv again
        const connectionDiv = document.getElementById("connection");
        connectionDiv.classList.remove("hide");
        alert(`Error acquiring display media: ${e.detail.name}. Please try again and ensure permissions are granted.`);
    });

    // Generic connected event (e.g., for client when video track is received, or host when a client is fully connected)
    connection.addEventListener("connected", (e) => {
        console.log("Connection established with peer:", e.detail);
        // For clients, e.detail might contain the dataChannel if implemented.
        // For hosts, this might be triggered per client (e.g. from handleAnswer)
        // drawingControls.enable might need adjustment based on who this event is for.
        if (!asHost) { // Client connected to host
            drawingControls.enable(e.detail?.dataChannel, webSocket); // Pass dataChannel if available
        } else {
            // Host side: e.detail contains { clientId }. 
            // If drawing controls need to be enabled per client, this is the place.
            // For now, host drawing controls are typically enabled once.
        }
    });

    // Host specific: a client has connected (after answer is processed)
    connection.addEventListener("clientconnected", (e) => {
        console.log(`Client ${e.detail.clientId} successfully connected to host.`);
        // If host needs to do something specific for each connected client.
    });
    
    // Handle data messages from data channels (if implemented and used)
    connection.addEventListener("datamessage", (e) => {
        console.log("Received data message:", e.detail);
        // Example: drawingControls.drawToCanvas(JSON.parse(e.detail.data));
    });

    // Listen for drawing complete events from DrawingControls
    drawingControls.addEventListener('drawingcomplete', (e) => {
        if (e.detail) { // Ensure there's data to send
            sendSignalMessage("drawing", e.detail);
        }
    });

    // Listen for canvas updates for OBS
    drawingControls.addEventListener('obsupdate', (e) => {
        if (e.detail) {
            sendSignalMessage("obs_canvas_data", { dataUri: e.detail });
        }
    });


    // Forward websocket signalling messages to the WebConnection instance
    webSocket.onopen = async () => {
        console.log("WebSocket connection opened.");
        await connection.create(asHost); // Initialize WebConnection (gets stream for host)
        // If it's a client, it might send a message to find available hosts, or wait for "host_available"
        if (!asHost) {
            console.log("Client: Requesting available hosts (or waiting for host_available).");
            // sendSignalMessage("find_hosts", {}); // Example, if server supports this
        }
    };

    webSocket.onclose = (e) => {
        console.log("WebSocket connection closed.", e);
        connection.closeAllConnections(); // Clean up WebRTC connections
        drawingControls.disable();
        // Optionally, show the connection buttons again
        // document.getElementById("connection").classList.remove("hide");
    };

    webSocket.onerror = (e) => {
        console.error("WebSocket error:", e);
    };

    webSocket.onmessage = (e) => {
        let jsonMsg;
        try {
            jsonMsg = JSON.parse(e.data);
        } catch (error) {
            console.error("Received non-JSON WebSocket message:", e.data);
            return; // Ignore non-JSON messages
        }

        console.log("WebSocket message received:", jsonMsg);

        // Handle signaling messages for WebRTC (host or client)
        if (jsonMsg.type === "client_requesting_offer" && isConnectionHost) {
            connection.handleClientRequest(jsonMsg.payload.clientId);
        } else if (jsonMsg.type === "answer" && isConnectionHost) { // Answer from a client
            connection.handleAnswer(jsonMsg.payload.fromId, jsonMsg.payload.sdp);
        } else if (jsonMsg.type === "candidate") { // Candidate for host or client
             if ((isConnectionHost && jsonMsg.payload.fromId) || (!isConnectionHost && jsonMsg.payload.fromId === connection.peerConnections.get("host")?.id)) {
                // More robust check might be needed if client can connect to multiple peers, or host has multiple clients
                // For now, assumes candidate is from a known peer or for the host.
                connection.handleCandidate(jsonMsg.payload.fromId, jsonMsg.payload.candidate);
             }
        }
        // Client specific WebRTC signaling
        else if (!isConnectionHost) {
            switch (jsonMsg.type) {
                case "host_available":
                    console.log("Host available:", jsonMsg.payload.hostId);
                    sendSignalMessage("request_offer", { hostId: jsonMsg.payload.hostId });
                    break;
                case "offer": // Offer from the host
                    connection.handleOffer(jsonMsg.payload.fromId, jsonMsg.payload.sdp);
                    break;
                // "candidate" is handled above now
                case "host_left":
                    console.log("Host left:", jsonMsg.payload.hostId);
                    connection.closeAllConnections();
                    drawingControls.disable();
                    alert("The host has disconnected.");
                    document.getElementById("connection").classList.remove("hide");
                    break;
                default:
                    // This default case will now also catch "drawing" messages if not handled before client specific logic
                    // console.log("Client received unhandled or non-specific message type:", jsonMsg.type);
                    break; 
            }
        } else { // Host specific messages not related to WebRTC signaling (if any)
             // console.log("Host received unhandled or non-specific message type:", jsonMsg.type);
        }

        // Handle drawing messages (for both host and client, if not the sender)
        // The server will broadcast drawing messages to all *other* clients.
        // The sender already drew it locally.
        if (jsonMsg.type === "drawing") {
            // Check if the message originated from this client to avoid re-drawing
            // This check might be complex if drawing messages don't carry original senderId client-side
            // For now, assume server doesn't send it back to sender.
            // If it does, main.js would need to know its own client ID from the server
            // or the drawing message payload would need to include senderId.
            // Let's assume server handles not sending back to sender.
            console.log("Received drawing message, calling drawShape", jsonMsg.payload);
            drawingControls.drawShape(jsonMsg.payload);
        } else if (jsonMsg.type === "clear_canvas") { // Example for a clear canvas message
            drawingControls.onClear(); // Assuming onClear handles local clearing and OBS update
        } else if (jsonMsg.type === "undo_stroke") { // Example for an undo message
            // This would require more complex state management (e.g. undoing specific user's stroke)
            // For now, local undo is separate. If global undo is needed, server must manage drawing history.
        }

        // OBS updates are sent by clients, server doesn't broadcast them back.
        // Server handles obs_canvas_data directly.
    };
}

// Global error handler for logging
window.onerror = (message, source, lineno, colno, error) => {
    const errorLog = `ERROR: ${message} at ${source}:${lineno}:${colno}`;
    console.error(errorLog, error);
    if (webSocket && webSocket.readyState === WebSocket.OPEN) {
        // Using 'l' prefix for generic log as per server.js existing non-JSON handling
        // Or define a new JSON type for client-side errors if preferred
        webSocket.send(`l${errorLog}`); // Ensure server handles this, or use sendSignalMessage
            }
        }
    };
}

// Global error handler for logging
window.onerror = (message, source, lineno, colno, error) => {
    const errorLog = `ERROR: ${message} at ${source}:${lineno}:${colno}`;
    console.error(errorLog, error);
    if (webSocket && webSocket.readyState === WebSocket.OPEN) {
        // Using 'l' prefix for generic log as per server.js existing non-JSON handling
        // Or define a new JSON type for client-side errors if preferred
        webSocket.send(`l${errorLog}`); // Ensure server handles this, or use sendSignalMessage
    }
}

window.addEventListener("DOMContentLoaded", () => initialize());