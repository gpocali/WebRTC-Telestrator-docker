class DrawingControls {
    /** @type {RTCDataChannel} */
    #dataChannel
    /** @type {WebSocket} */
    #webSocket;
    /** @type {HTMLCanvasElement} */
    #canvas;
    /** @type {CanvasRenderingContext2D} */
    #context;
    /** @type {DOMRect} */
    #canvasRect;
    // #scale property removed
    /** @type {PointerEvent} */
    #firstPointer;
    /** @type {ImageData[]} */
    #undoStack = []; // Remains for now, but not effectively used
    #undoIndex = -1; // Remains for now, but not effectively used
    #lineColor = "black";
    #lineWidth = 1; // Stores raw slider value (0-10)
    #currentTool = "pencil"; // Added property
    #arrowStartPoint = null; // Added property
    toolButtons = []; // Added property for managing tool button states
    #isDrawing = false;
    // #hasCanvasChanged = false; // Appears unused, removing
    // #offset property removed
    // #inset property removed
    #frameTimeout = null; // Related to old PNG sending, may be removed if #sendData changes completely

    /**
     * Create an instance of the drawing controls
     * @param {boolean} isDebugMode 
     */
    constructor(isDebugMode) {
        // Create the canvas context
        this.#canvas = document.getElementById("canvas");
        this.#canvas.width = 1920; // Fixed resolution
        this.#canvas.height = 1080; // Fixed resolution
        this.#context = this.#canvas.getContext("2d", { willReadFrequently: true });
        this.#canvasRect = this.#canvas.getBoundingClientRect(); // Initial rect

        // Listen to pointer events for drawing
        this.#canvas.addEventListener("pointerdown", (e) => this.#onStart(e));
        this.#canvas.addEventListener("pointermove", (e) => this.#onMove(e));
        this.#canvas.addEventListener("pointerup", (e) => this.#onStop(e));
        this.#canvas.addEventListener("pointerout", (e) => this.#onStop(e));

        // Load settings
        // Offset and Inset loading removed
        const lineWidth = localStorage.getItem("lineWidth");
        if (typeof lineWidth === "string") {
            this.#lineWidth = parseInt(lineWidth); // Store raw value (0-10)
        }
        const lineWidthControl = document.getElementById("lineWidth");
        lineWidthControl.addEventListener("change", (e) => this.#onLineWidthChange(e));
        lineWidthControl.value = this.#lineWidth;

        const lineColor = localStorage.getItem("lineColor");
        if (typeof lineColor === "string") {
            this.#lineColor = lineColor;
            this.#onLineColorChange(this.#lineColor); // This method updates UI selectors
        }

        document.querySelectorAll(".colorOption").forEach((element) => {
            element.addEventListener("click", (e) => this.#onLineColorChange(e.target.style.background));
        });
        document.getElementById("colorPicker").addEventListener("change", (e) => this.#onLineColorChange(e.target.value));

        // Listen to drawing action events
        document.getElementById("fullscreen").addEventListener("click", (e) => this.#onToggleFullScreen(e));
        document.getElementById("toggleTools").addEventListener("click", (e) => this.#onToggleTools(e));
        document.getElementById("undo").addEventListener("click", (e) => this.#onUndo(e));
        document.getElementById("clear").addEventListener("click", (e) => this.#onClear(e));

        // Tool selection buttons
        const pencilButton = document.getElementById("toolPencil");
        const arrowButton = document.getElementById("toolArrow");
        const checkmarkButton = document.getElementById("toolCheckmark");
        const xButton = document.getElementById("toolX");

        this.toolButtons = [pencilButton, arrowButton, checkmarkButton, xButton];

        pencilButton.addEventListener("click", () => this.#selectTool("pencil", pencilButton));
        arrowButton.addEventListener("click", () => this.#selectTool("arrow", arrowButton));
        checkmarkButton.addEventListener("click", () => this.#selectTool("checkmark", checkmarkButton));
        xButton.addEventListener("click", () => this.#selectTool("x", xButton));

        this.#selectTool("pencil", pencilButton); // Select pencil by default

        if (isDebugMode) {
            this.enable(null, null);
        }
    }

    #selectTool(toolName, selectedButton) {
        this.#currentTool = toolName;

        // Update visual feedback for selected tool
        this.toolButtons.forEach(button => {
            if (button === selectedButton) {
                button.classList.add("selected");
            } else {
                button.classList.remove("selected");
            }
        });

        // Optional: Log the selected tool
        console.log("Tool selected:", this.#currentTool);
    }

    /**
     * Create a new instance of the DrawingControls
     * @param {RTCDataChannel} dataChannel
     * @param {WebSocket} webSocket 
     */
    enable(dataChannel, webSocket) {
        this.#dataChannel = dataChannel;
        this.#webSocket = webSocket;

        const video = document.getElementById("video");
        video.classList.remove("hide");
        document.getElementById("connection").classList.add("hide");
        document.getElementById("drawing").classList.remove("hide");

        video.addEventListener("resize", (e) => this.#onResize(video));
        window.addEventListener("resize", (e) => this.#onResize(video));

        if (!dataChannel || !webSocket) {
            video.src = "v.mp4";
        }
    }

    /**
     * Draw to the canvas using json payload
     * @param {any} e 
     */
    drawToCanvas(command) {
        // command would be like { action: "start" / "move" / "stop" / "draw", tool, x, y, color, size, startX, startY, endX, endY }
        this.#context.strokeStyle = command.color;
        this.#context.fillStyle = command.color; // For filled shapes like arrowheads, checkmark, X
        const calculatedLineWidth = command.size * 5 + 1; // Example scaling
        this.#context.lineWidth = calculatedLineWidth;
        this.#context.lineCap = "round"; // Default for most tools
        this.#context.lineJoin = "round"; // Default for most tools

        switch (command.action) {
            case "start": // Pencil only
                this.#context.beginPath();
                this.#context.moveTo(command.x, command.y);
                break;
            case "move": // Pencil only
                this.#context.lineTo(command.x, command.y);
                this.#context.stroke();
                break;
            case "stop": // Pencil only
                this.#context.stroke();
                this.#context.closePath();
                break;
            case "draw": // For new tools (arrow, checkmark, x)
                switch (command.tool) {
                    case "arrow":
                        this.#context.beginPath();
                        this.#context.moveTo(command.startX, command.startY);
                        this.#context.lineTo(command.endX, command.endY);
                        // Basic arrowhead (can be improved)
                        const angle = Math.atan2(command.endY - command.startY, command.endX - command.startX);
                        const headlen = 15 * (command.size / 5 + 1); // Scale arrowhead with size
                        this.#context.lineTo(command.endX - headlen * Math.cos(angle - Math.PI / 6), command.endY - headlen * Math.sin(angle - Math.PI / 6));
                        this.#context.moveTo(command.endX, command.endY);
                        this.#context.lineTo(command.endX - headlen * Math.cos(angle + Math.PI / 6), command.endY - headlen * Math.sin(angle + Math.PI / 6));
                        this.#context.stroke();
                        this.#context.closePath();
                        break;
                    case "checkmark":
                        // Basic checkmark (size based on command.size)
                        const chkSize = 20 * (command.size / 5 + 1);
                        this.#context.beginPath();
                        this.#context.moveTo(command.x - chkSize / 2, command.y);
                        this.#context.lineTo(command.x, command.y + chkSize / 2);
                        this.#context.lineTo(command.x + chkSize, command.y - chkSize / 2);
                        this.#context.stroke();
                        this.#context.closePath();
                        break;
                    case "x":
                        // Basic X (size based on command.size)
                        const xSize = 20 * (command.size / 5 + 1);
                        this.#context.beginPath();
                        this.#context.moveTo(command.x - xSize / 2, command.y - xSize / 2);
                        this.#context.lineTo(command.x + xSize / 2, command.y + xSize / 2);
                        this.#context.moveTo(command.x + xSize / 2, command.y - xSize / 2);
                        this.#context.lineTo(command.x - xSize / 2, command.y + xSize / 2);
                        this.#context.stroke();
                        this.#context.closePath();
                        break;
                }
                break;
            case "clear":
                this.#context.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
                break;
            // Removed resize case as it's not expected with fixed canvas resolution
        }
    }

    #sendData(payload) { // Removed useDoubleBuffer
        // PNG sending logic removed
        if (this.#webSocket && payload) {
            // Add tool, color, and size to every drawing action payload
            const fullPayload = {
                ...payload,
                tool: this.#currentTool, // Use the dynamic current tool
                color: this.#lineColor,
                size: this.#lineWidth // This is the 0-10 range value
            };
            this.#webSocket.send(JSON.stringify(fullPayload));
        }
        // The dataChannel part is for host to see client drawings.
        // If this is still needed, it should also send the fullPayload.
        // For now, assuming primary communication is WebSocket.
        // if (this.#dataChannel && payload) {
        //     this.#dataChannel.send(JSON.stringify(fullPayload));
        // }
    }

    #onStart(e) {
        if (this.#firstPointer) {
            e.preventDefault();
            return false;
        }
        this.#firstPointer = e;
        const x = this.#getX(e);
        const y = this.#getY(e);

        // Set styles for local drawing (will be applied if the tool draws locally)
        this.#context.strokeStyle = this.#lineColor;
        this.#context.lineWidth = this.#lineWidth * 5 + 1;
        this.#context.lineCap = "round";
        this.#context.lineJoin = "round";

        switch (this.#currentTool) {
            case "pencil":
                this.#isDrawing = true;
                this.#context.beginPath();
                this.#context.moveTo(x, y);
                this.#sendData({ action: "start", x, y });
                break;
            case "arrow":
                this.#arrowStartPoint = { x, y };
                this.#isDrawing = true; // For local preview in #onMove
                // Optional: For local preview of arrow line start
                // this.#context.beginPath();
                // this.#context.moveTo(x, y);
                break;
            case "checkmark":
                this.#sendData({ action: "draw", x, y }); // tool, color, size added by #sendData
                // Local draw for immediate feedback
                this.drawToCanvas({ action: "draw", tool: "checkmark", x, y, color: this.#lineColor, size: this.#lineWidth });
                this.#isDrawing = false; // Not a dragging tool
                break;
            case "x":
                this.#sendData({ action: "draw", x, y }); // tool, color, size added by #sendData
                // Local draw for immediate feedback
                this.drawToCanvas({ action: "draw", tool: "x", x, y, color: this.#lineColor, size: this.#lineWidth });
                this.#isDrawing = false; // Not a dragging tool
                break;
        }
        e.preventDefault();
        return false;
    }

    #onMove(e) {
        if (this.#firstPointer && e.pointerId !== this.#firstPointer.pointerId) {
            return false;
        }
        if (!this.#isDrawing) return false; // Only move if drawing is active

        const x = this.#getX(e);
        const y = this.#getY(e);

        switch (this.#currentTool) {
            case "pencil":
                this.#context.lineTo(x, y);
                this.#context.stroke(); // Local drawing
                this.#sendData({ action: "move", x, y }); // tool, color, size added by #sendData
                break;
            case "arrow":
                if (this.#arrowStartPoint) {
                    // Optional: Local preview logic for arrow
                    // (Clear previous preview and draw line from this.#arrowStartPoint to current x,y)
                    // This part is not sending data, only for local visual feedback.
                    // Example:
                    // this.#context.clearRect(0, 0, this.#canvas.width, this.#canvas.height); // Might need to redraw history if clearing full canvas
                    // this.#context.beginPath();
                    // this.#context.moveTo(this.#arrowStartPoint.x, this.#arrowStartPoint.y);
                    // this.#context.lineTo(x, y);
                    // this.#context.stroke();
                }
                break;
        }
        e.preventDefault();
        return false;
    }

    #onStop(e) {
        if (this.#firstPointer && e.pointerId !== this.#firstPointer.pointerId) {
            // If this is a multi-touch scenario and not the primary pointer, ignore.
            // However, for single pointer drawing, this might not be strictly necessary
            // if #firstPointer is always cleared correctly.
            return false;
        }

        const x = this.#getX(e); // Get final coordinates if needed
        const y = this.#getY(e);

        switch (this.#currentTool) {
            case "pencil":
                if (this.#isDrawing) {
                    this.#context.stroke(); // Ensure last segment is drawn locally
                    this.#context.closePath();
                    this.#sendData({ action: "stop" });
                }
                break;
            case "arrow":
                if (this.#isDrawing && this.#arrowStartPoint) {
                    // Send the final arrow command
                    this.#sendData({
                        action: "draw", // "draw" action for shapes
                        startX: this.#arrowStartPoint.x,
                        startY: this.#arrowStartPoint.y,
                        endX: x,
                        endY: y
                    });
                    // Local draw for immediate feedback (optional, if not relying on server echo for drawer)
                    this.drawToCanvas({ action: "draw", tool: "arrow", startX: this.#arrowStartPoint.x, startY: this.#arrowStartPoint.y, endX: x, endY: y, color: this.#lineColor, size: this.#lineWidth });
                    this.#arrowStartPoint = null;
                }
                break;
            case "checkmark":
            case "x":
                // No action needed in onStop for these point-and-click tools
                break;
        }

        this.#isDrawing = false; // Reset drawing state for all tools
        this.#firstPointer = null; // Reset first pointer

        e.preventDefault();
        return false;
    }

    #onUndo(e) {
        // For #onUndo and #onClear, send a specific clear command for now
        // This will be picked up by server.js and broadcast as { type: "clear_canvas" }
        // No payload needed beyond the action for the server to recognize it.
        if (this.#webSocket) {
            this.#webSocket.send(JSON.stringify({ action: "clear" }));
        }
        // Local canvas clear will happen when the message comes back from the server.
        // Or, if this is the client page, it won't clear locally until server message.

        e.preventDefault();
        return false;
    }

    #onClear(e) {
        if (this.#webSocket) {
            this.#webSocket.send(JSON.stringify({ action: "clear" }));
        }
        // Local canvas clear will happen when the message comes back from the server.

        e.preventDefault();
        return false;
    }

    #onToggleFullScreen(e) {
        const button = document.getElementById("fullscreen");
        if (!document.fullscreenElement) {
            document.body.requestFullscreen();
            button.innerHTML = "&#8690;";
        } else {
            document.exitFullscreen();
            button.innerHTML = "&#8689;";
        }
    }

    #onToggleTools(e) {
        const button = document.getElementById("toggleTools");
        if (!button.classList.contains("flip")) {
            const tools = document.querySelectorAll("#tools > *");
            tools.forEach((element) => {
                if (element.id !== "toggleTools") {
                    element.classList.add("hide");
                }
            });
            button.classList.add("flip");
        } else {
            const tools = document.querySelectorAll("#tools > *");
            tools.forEach((element) => {
                if (element.id !== "toggleTools") {
                    element.classList.remove("hide");
                }
            });
            button.classList.remove("flip");
        }
    }

    // #onOffsetChange method removed
    // #onInsetChange method removed

    #onLineWidthChange(e) {
        this.#lineWidth = parseInt(e.target.value); // Store raw value (0-10)
        localStorage.setItem("lineWidth", this.#lineWidth);
        // No direct context change here, it's used when sending data and local drawing.
    }

    #onLineColorChange(color) {
        this.#lineColor = color;
        localStorage.setItem("lineColor", this.#lineColor);

        let found = false;
        const tools = document.querySelectorAll("#tools > .colorOption");
        tools.forEach((element) => {
            element.classList.remove("selected");
            if (element.style.backgroundColor === color) {
                element.classList.add("selected");
                found = true;
            }
        });

        const picker = document.getElementById("colorPicker");
        if (!found) {
            picker.classList.add("selected");
            picker.value = this.#lineColor;
        } else {
            picker.classList.remove("selected");
        }
    }

    #onResize(video) { // video parameter might not be strictly needed anymore
        this.#canvasRect = this.#canvas.getBoundingClientRect();
        // The rest of the logic related to video dimensions, scaling the context,
        // and sending resize events has been removed.
        // Redrawing logic for local canvas might be needed if drawings disappear on resize,
        // but server is the source of truth.
    }

    // #getVideoDimensions method removed as it's part of old #onResize logic

    #getX(e) {
        const rect = this.#canvasRect; // Use the stored rect, update on resize
        const canvasLogicalWidth = this.#canvas.width;
        return (e.pageX - rect.left) * (canvasLogicalWidth / rect.width);
    }

    #getY(e) {
        const rect = this.#canvasRect; // Use the stored rect, update on resize
        const canvasLogicalHeight = this.#canvas.height;
        return (e.pageY - rect.top) * (canvasLogicalHeight / rect.height); // Use pageY
    }
}