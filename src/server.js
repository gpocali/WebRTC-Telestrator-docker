const os = require("os");
const express = require("express");
const WebSocketServer = require("ws").Server;
const { program, InvalidArgumentError } = require("commander");
const { dataUriToBuffer } = require("data-uri-to-buffer");
const crypto = require('crypto');

const emptyImage = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
let latestObsDataUri = emptyImage;

// Initialize client management variables
let clients = new Map();
let hostInfo = null;
let waitingClients = new Set(); // Clients waiting for a host

// Function to generate a unique ID
function generateUniqueId() {
    return crypto.randomUUID();
}

// Add the command line options
program
    .name("webrtc-telestator")
    .description("A remote telestrator app using WebRTC")
    .version("1.0.0", "-v, --version")
    .option("-p, --port <number>", "specify custom http port (default: 8888)", (value) => {
        const parsedValue = parseInt(value, 10);
        if (isNaN(parsedValue)) {
            throw new InvalidArgumentError("Not a number.");
        }
        return parsedValue;
    });

// Parse command line
program.parse(process.argv);
const opts = program.opts();
const port = opts.port || 8888;

// Create the websocket signaling server
const wsList = [];
const wsMessages = [];
const wss = new WebSocketServer({ port: (port + 1) });
wss.on("connection", function (ws) {
    const clientId = generateUniqueId();
    clients.set(clientId, ws);
    ws.id = clientId;
    console.log(`Client ${clientId} connected.`);

    if (!hostInfo) {
        waitingClients.add(clientId);
        console.log(`Client ${clientId} added to waiting list. Total waiting: ${waitingClients.size}`);
    } else {
        // Host exists, notify this new client immediately
        ws.send(JSON.stringify({"type": "host_available", "payload": {"hostId": hostInfo.id}}));
        console.log(`Notified newly connected client ${clientId} about existing host ${hostInfo.id}.`);
    }

    wsList.push(ws); // wsList usage is being reviewed/phased out but keep for now

    ws.on("close", function () {
        const clientId = ws.id;
        clients.delete(clientId);
        console.log(`Client ${clientId} disconnected.`);

        if (waitingClients.has(clientId)) {
            waitingClients.delete(clientId);
            console.log(`Client ${clientId} removed from waiting list. Total waiting: ${waitingClients.size}`);
        }

        if (hostInfo && hostInfo.id === clientId) {
            console.log(`Host ${clientId} has disconnected.`);
            hostInfo = null;
            latestObsDataUri = emptyImage; // Reset URI when host disconnects
            const hostLeftMessage = JSON.stringify({"type": "host_left", "payload": {"hostId": clientId}});
            for (const clientWs of clients.values()) {
                clientWs.send(hostLeftMessage);
            }
            console.log(`Broadcasted "host_left" notification to remaining clients.`);
        }

        wsList.splice(wsList.indexOf(ws), 1);
    });

    ws.on("message", function (message) {
        const msgString = message.toString();
        let jsonMessage;

        try {
            jsonMessage = JSON.parse(msgString);
        } catch (e) {
            // Not a JSON message, handle with existing logic
        }

        if (jsonMessage && jsonMessage.type === "declare_host") {
            const clientId = ws.id;
            if (!hostInfo || hostInfo.id === clientId) {
                hostInfo = { id: clientId, offerSdp: null, candidates: [] };
                console.log(`Client ${clientId} is now the host.`);
                for (const [targetClientId, clientWsInner] of clients) { // Renamed clientWs to avoid conflict
                    if (targetClientId !== clientId) { // Don't notify the host itself
                        clientWsInner.send(JSON.stringify({ "type": "host_available", "payload": { "hostId": clientId } }));
                    }
                }

                // Notify waiting clients
                if (waitingClients.size > 0) {
                    console.log(`Notifying ${waitingClients.size} waiting clients about new host ${clientId}.`);
                    for (const waitingClientId of waitingClients) {
                        const waitingClientWs = clients.get(waitingClientId);
                        if (waitingClientWs) {
                            waitingClientWs.send(JSON.stringify({ "type": "host_available", "payload": { "hostId": clientId } }));
                            console.log(`Sent host_available to waiting client ${waitingClientId}.`);
                        } else {
                            console.warn(`Could not find WebSocket for waiting client ${waitingClientId}. Removing from waiting list.`);
                            // waitingClients.delete(waitingClientId); // Set iteration modification issue, handle after loop or by collecting to array first
                        }
                    }
                    waitingClients.clear(); // Clear after notifying all
                    console.log("Waiting clients list cleared.");
                }
            } else {
                ws.send(JSON.stringify({ "type": "error", "payload": { "message": "Another host is already active." } }));
            }
        } else if (jsonMessage && jsonMessage.type === "request_offer") {
            const requestingClientId = ws.id;
            const targetHostId = jsonMessage.payload.hostId;

            if (hostInfo && hostInfo.id === targetHostId) {
                const hostWs = clients.get(targetHostId);
                if (hostWs) {
                    hostWs.send(JSON.stringify({ "type": "client_requesting_offer", "payload": { "clientId": requestingClientId } }));
                    console.log(`Relayed offer request from ${requestingClientId} to host ${targetHostId}`);
                } else {
                    // This case should ideally not happen if hostInfo is correctly maintained
                    console.error(`Host WebSocket not found for ID: ${targetHostId}`);
                    ws.send(JSON.stringify({ "type": "error", "payload": { "message": "Host not found." } }));
                }
            } else {
                ws.send(JSON.stringify({ "type": "error", "payload": { "message": "Requested host is not available." } }));
                console.log(`Requested host ${targetHostId} not available for client ${requestingClientId}`);
            }
        } else if (jsonMessage && jsonMessage.type === "offer") {
            const senderId = ws.id;

            if (hostInfo && hostInfo.id === senderId) {
                const targetClientId = jsonMessage.payload.toId;
                const sdpObject = jsonMessage.payload.sdp;
                const targetClientWs = clients.get(targetClientId);

                if (targetClientWs) {
                    targetClientWs.send(JSON.stringify({"type": "offer", "payload": {"fromId": senderId, "sdp": sdpObject}}));
                    console.log(`Relayed offer from host ${senderId} to client ${targetClientId}`);
                } else {
                    console.error(`Target client WebSocket not found for ID: ${targetClientId}`);
                    // Optional: Inform the host
                    ws.send(JSON.stringify({ "type": "error", "payload": { "message": `Client ${targetClientId} not found.` } }));
                }
            } else {
                console.warn(`Non-host client ${senderId} attempted to send an offer.`);
                // Optional: Send an error back to the sender
                ws.send(JSON.stringify({ "type": "error", "payload": { "message": "Only the host can send offers." } }));
            }
        } else if (jsonMessage && jsonMessage.type === "answer") {
            const senderId = ws.id;
            const targetHostId = jsonMessage.payload.toId;
            const sdpObject = jsonMessage.payload.sdp;

            if (hostInfo && hostInfo.id === targetHostId) {
                const hostWs = clients.get(targetHostId);
                if (hostWs) {
                    hostWs.send(JSON.stringify({"type": "answer", "payload": {"fromId": senderId, "sdp": sdpObject}}));
                    console.log(`Relayed answer from client ${senderId} to host ${targetHostId}`);
                } else {
                    console.error(`Host WebSocket not found for ID: ${targetHostId} when relaying answer from ${senderId}`);
                }
            } else {
                console.warn(`Client ${senderId} attempted to send an answer to a non-host or inactive host ${targetHostId}.`);
                 ws.send(JSON.stringify({ "type": "error", "payload": { "message": "Target host not available." } }));
            }
        } else if (jsonMessage && jsonMessage.type === "candidate") {
            const senderId = ws.id;
            const targetPeerId = jsonMessage.payload.toId;
            const candidateObject = jsonMessage.payload.candidate;
            const targetPeerWs = clients.get(targetPeerId);

            if (targetPeerWs) {
                targetPeerWs.send(JSON.stringify({"type": "candidate", "payload": {"fromId": senderId, "candidate": candidateObject}}));
                console.log(`Relayed ICE candidate from ${senderId} to ${targetPeerId}`);
            } else {
                console.error(`Target peer WebSocket not found for ID: ${targetPeerId} when relaying ICE candidate from ${senderId}`);
                 ws.send(JSON.stringify({ "type": "error", "payload": { "message": `Target peer ${targetPeerId} not found.` } }));
            }
        } else if (jsonMessage && jsonMessage.type === "drawing") {
            // Broadcast drawing data to all other clients
            const senderId = ws.id;
            console.log(`Broadcasting drawing from ${senderId}:`, jsonMessage.payload.shape);
            for (const [clientId, clientWs] of clients) {
                if (clientId !== senderId) {
                    clientWs.send(msgString); // Send the original stringified JSON
                }
            }
        } else if (jsonMessage && jsonMessage.type === "obs_canvas_data") {
            latestObsDataUri = jsonMessage.payload.dataUri;
            // console.log(`Updated latestObsDataUri from ${ws.id}`); // Optional: for debugging
        }
         else {
            // Existing message handling logic for non-WebRTC, non-drawing JSON messages
            // OR non-JSON messages (e.g. 'l' for log, 'r' for request - though 'r' might be obsolete)
            if (!jsonMessage) { // Was not JSON, handle old prefixes
                if (msgString[0] === "l") {
                    // Log the message
                    console.log(msgString);
                } else if (msgString[0] === "r") {
                    // On a request for host info, just fire any cached messages
                    // This 'r' message type might be obsolete or needs rethinking with new host logic
                    console.log("Received 'r' message, current wsMessages:", wsMessages);
                    // It's unclear if wsMessages is still used or relevant with new signaling.
                    // If it is, it should probably send JSON messages if clients expect them.
                    // For now, keeping original logic but noting it might be deprecated.
                    while (wsMessages.length > 0) {
                        const cachedMsg = wsMessages.pop(); 
                        for (const clientWs of clients.values()) { // Use clients map
                            clientWs.send(cachedMsg);
                        }
                    }
                } else {
                     // Original broadcast logic for non-JSON, non-d, non-l, non-r messages
                    // This part might also need review based on new signaling
                    // This logic is likely deprecated as most comms are JSON now.
                    console.log(`Received unhandled non-JSON message from ${ws.id}: ${msgString.substring(0, 50)}`);
                    if (clients.size < 2 && !hostInfo) { 
                        wsMessages.push(msgString);
                    } else {
                        for (const [clientId, clientWs] of clients) {
                            if (clientWs !== ws) {
                                 clientWs.send(msgString);
                            }
                        }
                    }
                }
            } else {
                // JSON message, but not one of the handled types above
                console.log(`Received unhandled JSON message type: ${jsonMessage.type} from ${ws.id}`);
            }
        }
    });
});

// Create the http server to serve the html files
app = express();
app.get("/img", (req, res) => {
    res.writeHead(200, {
        "Content-Type": "multipart/x-mixed-replace; boundary=--myboundary",
        "Cache-Control": "no-cache",
        "Connection": "close",
        "Pragma": "no-cache"
    });

    const writeFrame = () => {
        if (res.writableEnded) return; // Stop if client disconnected
        try {
            const buffer = dataUriToBuffer(latestObsDataUri); // Define buffer inside, it might throw
            const mjpegBytes = Buffer.from(buffer.buffer); // dataUriToBuffer now returns object with buffer
            res.write("--myboundary\r\n");
            res.write("Content-Type: image/png\r\n");
            res.write("Content-Length: " + mjpegBytes.length + "\r\n\r\n");
            res.write(mjpegBytes, "binary");
        } catch (error) {
            // console.error("Error writing MJPEG frame:", error);
            // Consider ending response or clearing interval if error is persistent
            // For now, if dataUriToBuffer fails (e.g. malformed URI), it might skip a frame
        }
    };

    // Send the first frame immediately
    writeFrame();

    // Then, set an interval to repeatedly send the latestObsDataUri
    const frameInterval = setInterval(writeFrame, 100); // Send frame every 100ms

    // Clean up interval when client disconnects
    req.on("close", () => {
        clearInterval(frameInterval);
        res.end();
    });
});
app.use(express.static(__dirname + "/public"));

app.listen(port, () => {
    console.log(``);
    console.log(`---------------------------`);
    console.log(`Welcome to WebRTC-Telestrator`);
    console.log(`---------------------------`);
    console.log(`Http server is running on port ${port}`);
    console.log(`WebSocket server is running on port ${parseInt(port) + 1}`);
    console.log(``);
    console.log(`1. Add a BrowserSource to http://localhost:${port}/obs.html`);
    console.log(`2. Open a local browser to http://localhost:${port} and click "Host" to select a sharing window`);
    console.log(`3. Open a remote browser to http://${os.hostname()}:${port} and click "Join" to begin telestrating`);
    console.log(``);
});