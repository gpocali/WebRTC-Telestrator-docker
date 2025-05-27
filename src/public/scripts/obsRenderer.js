const canvas = document.getElementById("obsCanvasElement");
const ctx = canvas.getContext("2d");

const wsPort = location.port ? parseInt(location.port) + 1 : 8889;
const wsUrl = `ws://${location.hostname}:${wsPort}`;
let webSocket;

console.log(`Attempting to connect to WebSocket at ${wsUrl}`);

function connectWebSocket() {
  webSocket = new WebSocket(wsUrl);

  webSocket.onopen = () => {
    console.log("OBS Renderer WebSocket connected.");
    webSocket.send(JSON.stringify({ type: "obs_client_hello" }));
  };

  webSocket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.type === "draw_batch" && Array.isArray(data.commands)) {
        data.commands.forEach(command => handleDrawingCommand(command));
      } else if (data.type === "draw_command") {
        handleDrawingCommand(data.payload);
      } else if (data.type === "clear_canvas") {
        console.log("Received clear_canvas command");
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    } catch (error) {
      console.error("Error processing message:", error, event.data);
    }
  };

  webSocket.onerror = (error) => {
    console.error("WebSocket Error:", error);
  };

  webSocket.onclose = (event) => {
    console.log("WebSocket closed:", event.code, event.reason);
    // Optional: attempt to reconnect
    // setTimeout(connectWebSocket, 5000); // Reconnect after 5 seconds
  };
}

function handleDrawingCommand(command) {
    // ctx is assumed to be globally available in this script or passed appropriately
    ctx.strokeStyle = command.color;
    ctx.fillStyle = command.color; // For filled parts like arrowheads, or if check/X are filled
    
    // Adjust size calculation as needed, this mirrors drawingControls.js
    // If command.size is undefined (e.g. for old "stop" commands without size), provide a default.
    const currentSize = command.size !== undefined ? command.size : 0; // Default size if not provided
    const calculatedLineWidth = currentSize * 5 + 1; 
    ctx.lineWidth = calculatedLineWidth;
    ctx.lineCap = "round"; // Good default for pencil
    ctx.lineJoin = "round"; // Good default for pencil

    switch (command.action) {
        case "start": // Pencil only
            ctx.beginPath();
            ctx.moveTo(command.x, command.y);
            break;
        case "move": // Pencil only
            ctx.lineTo(command.x, command.y);
            ctx.stroke();
            break;
        case "stop": // Pencil only
            // For pencil, the final stroke segment might have been done by the last 'move'.
            // Calling stroke() again is usually harmless or ensures the segment if no move preceded.
            ctx.stroke(); 
            ctx.closePath();
            break;
        case "draw": // New tools (arrow, checkmark, x)
            switch (command.tool) {
                case "arrow":
                    ctx.beginPath();
                    ctx.moveTo(command.startX, command.startY);
                    ctx.lineTo(command.endX, command.endY);
                    
                    // Arrowhead logic (mirroring drawingControls.js)
                    // Ensure arrowhead is filled and part of the same path or a new one
                    const angle = Math.atan2(command.endY - command.startY, command.endX - command.startX);
                    // Scale arrowhead size with line width (command.size)
                    const headlen = 15 * (currentSize / 5 + 1); // Arrowhead length
                    
                    ctx.stroke(); // Draw the line first

                    // Draw a filled triangular arrowhead
                    ctx.beginPath(); // Start new path for filled triangle
                    ctx.moveTo(command.endX, command.endY);
                    ctx.lineTo(command.endX - headlen * Math.cos(angle - Math.PI / 6), command.endY - headlen * Math.sin(angle - Math.PI / 6));
                    ctx.lineTo(command.endX - headlen * Math.cos(angle + Math.PI / 6), command.endY - headlen * Math.sin(angle + Math.PI / 6));
                    ctx.closePath(); // Close path for filling
                    ctx.fill(); // Fill the arrowhead
                    break;
                case "checkmark":
                    // Checkmark logic (mirroring drawingControls.js)
                    // Ensure lineCap and lineJoin are suitable if not 'round' for checkmark.
                    // For a sharper checkmark, you might use 'butt' or 'square' for cap/join temporarily.
                    const chkSize = 20 * (currentSize / 5 + 1); // Scale with command.size
                    ctx.beginPath();
                    ctx.moveTo(command.x - chkSize / 2, command.y);
                    ctx.lineTo(command.x, command.y + chkSize / 2);
                    ctx.lineTo(command.x + chkSize, command.y - chkSize / 2);
                    ctx.stroke(); // Stroke the path
                    // No closePath() needed for an open path like a checkmark if not filling.
                    break;
                case "x":
                    // X logic (mirroring drawingControls.js)
                    const xSize = 20 * (currentSize / 5 + 1); // Scale with command.size
                    ctx.beginPath();
                    ctx.moveTo(command.x - xSize / 2, command.y - xSize / 2);
                    ctx.lineTo(command.x + xSize / 2, command.y + xSize / 2);
                    ctx.moveTo(command.x + xSize / 2, command.y - xSize / 2); // New sub-path for the second line of X
                    ctx.lineTo(command.x - xSize / 2, command.y + xSize / 2);
                    ctx.stroke(); // Stroke the path
                    break;
                default:
                    console.warn("Unknown tool for draw action:", command.tool, command);
                    break;
            }
            break;
        default:
            console.warn("Unknown drawing command action:", command.action, command);
            break;
    }
}

// Initialize WebSocket connection
connectWebSocket();
