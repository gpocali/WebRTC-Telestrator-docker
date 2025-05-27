const os = require("os");
const express = require("express");
const WebSocket = require("ws"); // Corrected: WebSocketServer is WebSocket.Server or just WebSocket
const { program, InvalidArgumentError } = require("commander");

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

// Drawing state
let drawingHistory = [];

// Create the websocket signaling server
const wsList = []; // Maintained for compatibility, but wss.clients is preferred for broadcasting
const wsMessages = []; // Cache for WebRTC signaling before client connection
const wss = new WebSocket.Server({ port: (port + 1) }); // Corrected: WebSocket.Server

wss.on("connection", function (ws) {
    wsList.push(ws); // Keep manual list if needed for specific logic, or phase out
    console.log("Client connected. Total clients:", wss.clients.size);

    ws.on("close", function () {
        wsList.splice(wsList.indexOf(ws), 1); // Manage manual list
        console.log("Client disconnected. Total clients:", wss.clients.size);
        // No specific action needed for drawingHistory on disconnect for now
    });

    ws.on("message", function (messageStr) {
        let parsedMessage;
        try {
            parsedMessage = JSON.parse(messageStr);
        } catch (e) {
            // Not JSON, handle as plain string
            const msgString = messageStr.toString();
            if (msgString.startsWith("l")) { // Log message
                console.log(msgString);
            } else if (msgString.startsWith("r")) { // Request for host info (WebRTC setup)
                // On a request for host info, just fire any cached messages
                // These are assumed to be WebRTC signaling messages
                while (wsMessages.length > 0) {
                    const cachedMsg = wsMessages.pop();
                    // Broadcast cached messages to all clients (original behavior)
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(cachedMsg);
                        }
                    });
                }
            } else {
                console.warn("Received non-JSON, non-recognized plain string message:", msgString);
            }
            return; // Exit if not JSON
        }

        // Handle parsed JSON messages
        if (parsedMessage.type === "obs_client_hello") {
            console.log("OBS client connected, sending drawing history.");
            ws.send(JSON.stringify({ type: "draw_batch", commands: drawingHistory }));
        } else if (parsedMessage.action && parsedMessage.tool) { // Drawing command from drawer
            drawingHistory.push(parsedMessage);
            const drawCommandForObs = { type: "draw_command", payload: parsedMessage };
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify(drawCommandForObs));
                }
            });
        } else if (parsedMessage.action === "clear" || parsedMessage.type === "clear_canvas_command") { // Clear canvas command
            console.log("Received clear canvas command.");
            drawingHistory = [];
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: "clear_canvas" }));
                }
            });
        } else if (parsedMessage.action === "offer" || parsedMessage.action === "answer" || parsedMessage.candidate || parsedMessage.description) {
            // WebRTC signaling (offer, answer, candidate, description)
            // The original code cached these if wsList.length < 2, else broadcasted.
            // We'll adopt broadcasting to all clients, which is simpler.
            // If specific routing is needed (e.g., only to a peer), that's a more complex setup.
            let targetSent = false;
            if (parsedMessage.id) { // If there's an ID, try to send to that specific client first (if it's not the sender)
                for (const client of wss.clients) {
                    // This simple ID check isn't a full session management but can help direct messages
                    // A more robust system would involve session IDs or similar
                    if (client !== ws && client.id === parsedMessage.id && client.readyState === WebSocket.OPEN) {
                         client.send(messageStr.toString()); // Send original string
                         targetSent = true;
                         break;
                    }
                }
            }

            if (!targetSent) { // If no specific target or target not found, broadcast to others
                 wss.clients.forEach(client => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(messageStr.toString()); // Send original string
                    }
                });
            }
             // Cache message if no other client is connected yet (original behavior for WebRTC)
            // This means if only the current sender 'ws' is connected, messages are cached.
            if (wss.clients.size <= 1) {
                 wsMessages.push(messageStr.toString());
            }

        } else {
            console.warn("Received unknown JSON message structure:", parsedMessage);
        }
    });
});

// Create the http server to serve the html files
const app = express(); // Corrected: app was not defined before
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