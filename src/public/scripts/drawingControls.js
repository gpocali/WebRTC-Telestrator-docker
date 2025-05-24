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
    /** @type {{x: number, y:number}} */
    #scale;
    /** @type {PointerEvent} */
    #firstPointer;
    /** @type {ImageData[]} */
    #undoStack = [];
    #undoIndex = -1;
    #lineColor = "black";
    #lineWidth = 1;
    #isDrawing = false;
    #hasCanvasChanged = false;
    #offset = 20;
    #inset = 1;
    #frameTimeout = null;
    currentShape = "freehand"; // Default shape

    // Properties for shape drawing
    // #isDrawing is already defined
    startPoint = { x: 0, y: 0 };
    currentEndPoint = { x: 0, y: 0 }; // For arrow preview
    lastDrawnPreview = null; // Stores ImageData to clear previous preview
    freehandPoints = []; // For accumulating points for a freehand stroke

    /**
     * Create an instance of the drawing controls
     * @param {boolean} isDebugMode 
     */
    constructor(isDebugMode) {
        // Create the canvas context
        this.#canvas = document.getElementById("canvas");
        this.#context = this.#canvas.getContext("2d", { willReadFrequently: true });

        // Listen to pointer events for drawing
        this.#canvas.addEventListener("pointerdown", (e) => this.#onStart(e));
        this.#canvas.addEventListener("pointermove", (e) => this.#onMove(e));
        this.#canvas.addEventListener("pointerup", (e) => this.#onStop(e));
        this.#canvas.addEventListener("pointerout", (e) => this.#onStop(e));

        // Load settings
        const loadedOffset = localStorage.getItem("offset");
        if (typeof loadedOffset === "string") {
            this.#offset = parseInt(loadedOffset);
        }
        const offsetControl = document.getElementById("offset");
        offsetControl.addEventListener("change", (e) => this.#onOffsetChange(e));
        offsetControl.value = this.#offset;

        const loadedInset = localStorage.getItem("inset");
        if (typeof loadedInset === "string") {
            this.#inset = parseInt(loadedInset);
        }
        const insetControl = document.getElementById("inset");
        insetControl.addEventListener("change", (e) => this.#onInsetChange(e));
        insetControl.value = this.#inset;

        const lineWidth = localStorage.getItem("lineWidth");
        if (typeof lineWidth === "string") {
            this.#lineWidth = parseInt(lineWidth);
        }
        const lineWidthControl = document.getElementById("lineWidth");
        lineWidthControl.addEventListener("change", (e) => this.#onLineWidthChange(e));
        lineWidthControl.value = this.#lineWidth;

        const lineColor = localStorage.getItem("lineColor");
        if (typeof lineColor === "string") {
            this.#lineColor = lineColor;
            this.#onLineColorChange(this.#lineColor);
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

        if (isDebugMode) {
            this.enable(null, null);
        }
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
    drawToCanvas(e) {
        switch (e.action) {
            case "resize":
                this.#canvas.width = e.width;
                this.#canvas.height = e.height;
                this.#canvasRect = this.#canvas.getBoundingClientRect();
    // No direct drawing from 'e' anymore, will be via drawShape
    this.dispatchEvent(new CustomEvent('obsupdate', { detail: this.#canvas.toDataURL('image/jpeg') })); // Or png
                break;
// The old "start", "move", "stop" cases for direct drawing are removed
// as drawing is now done via drawShape method using structured JSON data.
        }
    }

    // #sendData is removed as direct WebSocket communication for drawing
    // is now handled by main.js sending structured JSON messages.
    // The part that sends canvas data to OBS (via this.#webSocket.send(data))
    // will be triggered by an 'obsupdate' event.

    #onStart(e) {
        if (this.#firstPointer) {
            e.preventDefault();
            return false;
        }

        this.#firstPointer = e;
        this.startPoint = { x: this.#getX(e), y: this.#getY(e) };
        this.#isDrawing = true;
        this.freehandPoints = []; // Clear points for new stroke

        if (this.currentShape === "freehand") {
            this.#context.beginPath();
            this.#context.moveTo(this.startPoint.x, this.startPoint.y);
            this.freehandPoints.push({ x: this.startPoint.x, y: this.startPoint.y });
        } else {
            // For other shapes, capture the current canvas state for preview restoration
            if (this.#undoStack.length > 0 && this.#undoIndex >= 0) {
                this.lastDrawnPreview = this.#undoStack[this.#undoIndex];
            } else {
                // If undo stack is empty, save the current blank canvas state (or a clear rect)
                // For simplicity, if undo stack is empty, preview will draw on current canvas
                // and onStop will be the first thing pushed to undo stack.
                // A more robust way is to always have a base canvas image.
                this.lastDrawnPreview = this.#context.getImageData(0, 0, this.#canvas.width, this.#canvas.height);

            }
        }
        e.preventDefault();
        return false;
    }

    #onMove(e) {
        if (this.#firstPointer && e.pointerId !== this.#firstPointer.pointerId) {
            return false;
        }
        if (!this.#isDrawing) return false;

        const currentPoint = { x: this.#getX(e), y: this.#getY(e) };

        if (this.currentShape === "freehand") {
            this.#context.lineTo(currentPoint.x, currentPoint.y);
            this.#context.strokeStyle = this.#lineColor;
            this.#context.lineWidth = this.#lineWidth * 5 + 1; // Keep existing scaling
            this.#context.lineCap = "round";
            this.#context.lineJoin = "round";
            this.#context.stroke();
            this.freehandPoints.push({ x: currentPoint.x, y: currentPoint.y });
            // No sendData here anymore for freehand move
        } else if (this.currentShape === "arrow" || this.currentShape === "checkmark" || this.currentShape === "x") {
            this.currentEndPoint = currentPoint;
            // Preview drawing logic remains the same
            if (this.lastDrawnPreview) {
                this.#context.putImageData(this.lastDrawnPreview, 0, 0);
            } else {
                 // Fallback if lastDrawnPreview wasn't captured (e.g. clear canvas)
                 this.#context.clearRect(0,0,this.#canvas.width, this.#canvas.height);
                 // Or, if undo stack has items, use the last one.
                 if (this.#undoStack.length > 0 && this.#undoIndex >= 0) {
                    this.#context.putImageData(this.#undoStack[this.#undoIndex], 0, 0);
                 }
            }


            const tempLineWidth = this.#lineWidth * 5 + 1; // Consistent with freehand

            if (this.currentShape === "arrow") {
                this._drawArrow(this.#context, this.startPoint.x, this.startPoint.y, this.currentEndPoint.x, this.currentEndPoint.y, this.#lineColor, tempLineWidth);
            } else { // checkmark or x
                const dx = this.currentEndPoint.x - this.startPoint.x;
                const dy = this.currentEndPoint.y - this.startPoint.y;
                // Using distance as a simple scale factor. More sophisticated scaling might be needed.
                const scale = Math.sqrt(dx * dx + dy * dy) / 50; // 50 is an arbitrary base size
                this._drawMark(this.#context, this.currentShape, this.startPoint.x, this.startPoint.y, scale, this.#lineColor, tempLineWidth);
            }
        }
        e.preventDefault();
        return false;
    }

    #onStop(e) {
        if (this.#firstPointer && e.pointerId !== this.#firstPointer.pointerId) {
            return false;
        }
        this.#firstPointer = null;
        if (!this.#isDrawing) return false;
        
        this.#isDrawing = false;
        const endPoint = { x: this.#getX(e), y: this.#getY(e) };
        const finalLineWidth = this.#lineWidth * 5 + 1; // Consistent thickness

        // Restore canvas to state before preview drawing started for shapes
        if (this.currentShape !== "freehand" && this.lastDrawnPreview) {
            this.#context.putImageData(this.lastDrawnPreview, 0, 0);
        }

        const shapeDataForTransmission = this._getShapeDataForTransmission(endPoint);

        // Draw the final shape locally (this ensures it's on the canvas before OBS update)
        if (this.currentShape === "freehand") {
            // For freehand, local drawing happened during onMove. Finalize path.
            this.#context.stroke(); // Ensure last segment is drawn if path wasn't closed
            this.#context.closePath();
        } else if (this.currentShape === "arrow") {
            this._drawArrow(this.#context, shapeDataForTransmission.startX, shapeDataForTransmission.startY, shapeDataForTransmission.endX, shapeDataForTransmission.endY, shapeDataForTransmission.color, finalLineWidth);
        } else if (this.currentShape === "checkmark" || this.currentShape === "x") {
            this._drawMark(this.#context, shapeDataForTransmission.shape, shapeDataForTransmission.centerX, shapeDataForTransmission.centerY, shapeDataForTransmission.scale, shapeDataForTransmission.color, finalLineWidth);
        }
        
        // Common logic for all shapes
        this.#undoStack.push(this.#context.getImageData(0, 0, this.#canvas.width, this.#canvas.height));
        this.#undoIndex++;
        this.lastDrawnPreview = null; // Clear preview state
        this.freehandPoints = [];    // Clear points for next stroke

        // Dispatch event with shape data for main.js to send over WebSocket
        if (shapeDataForTransmission) {
            this.dispatchEvent(new CustomEvent('drawingcomplete', { detail: shapeDataForTransmission }));
        }
        // Dispatch event to update OBS
        this.dispatchEvent(new CustomEvent('obsupdate', { detail: this.#canvas.toDataURL('image/jpeg') }));


        e.preventDefault();
        return false;
    }

    _getShapeDataForTransmission(endPoint) {
        let data = {
            shape: this.currentShape,
            color: this.#lineColor,
            thickness: this.#lineWidth // Send original thickness, server/receiver will scale
        };

        if (this.currentShape === "freehand") {
            data.points = [...this.freehandPoints]; // Send copy of points
            // Add current endpoint if it wasn't the last point added (e.g. very short click-draw)
            if (this.freehandPoints.length === 0 || 
                (this.freehandPoints[this.freehandPoints.length-1].x !== endPoint.x || 
                 this.freehandPoints[this.freehandPoints.length-1].y !== endPoint.y)) {
                 // This check might be redundant if onMove always adds the last point,
                 // but good for safety on very short drags or clicks.
                 // However, for a simple click, startPoint and endPoint are the same.
                 // If freehandPoints has only one point (startPoint), and endPoint is different, add it.
                 // If it's a click (startPoint === endPoint) and only startPoint is there, it's fine.
                 if (this.freehandPoints.length === 1 && (this.startPoint.x !== endPoint.x || this.startPoint.y !== endPoint.y)) {
                    this.freehandPoints.push(endPoint); // Add the final point on stop
                    data.points = [...this.freehandPoints];
                 } else if (this.freehandPoints.length === 0) { // Single click case
                    data.points.push(this.startPoint); // Treat single click as a point
                 }
            }
        } else if (this.currentShape === "arrow") {
            data.startX = this.startPoint.x;
            data.startY = this.startPoint.y;
            data.endX = endPoint.x;
            data.endY = endPoint.y;
        } else if (this.currentShape === "checkmark" || this.currentShape === "x") {
            const dx = endPoint.x - this.startPoint.x;
            const dy = endPoint.y - this.startPoint.y;
            data.centerX = this.startPoint.x; // Or use midpoint: this.startPoint.x + dx / 2;
            data.centerY = this.startPoint.y; // Or use midpoint: this.startPoint.y + dy / 2;
            data.scale = Math.sqrt(dx * dx + dy * dy) / 50; // Adjust base size as needed
            if (data.scale === 0) data.scale = 0.1; // Prevent zero scale for single click
        }
        return data;
    }


    #onUndo(e) {
        if (this.#undoIndex <= 0) {
            this.#onClear(e); // This will also dispatch obsupdate
        } else {
            this.#undoIndex--;
            this.#undoStack.pop();
            if (e.type !== "mouseout") { // Should always be true for button click
                this.#context.putImageData(this.#undoStack[this.#undoIndex], 0, 0);
            }
            this.dispatchEvent(new CustomEvent('obsupdate', { detail: this.#canvas.toDataURL('image/jpeg') }));
        }
        this.lastDrawnPreview = null; // Clear any preview state
        e.preventDefault();
        return false;
    }

    #onClear(e) {
        this.#context.fillStyle = "transparent";
        this.#context.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
        this.#undoStack = [];
        this.#undoIndex = -1;
        this.lastDrawnPreview = null;
        this.dispatchEvent(new CustomEvent('obsupdate', { detail: this.#canvas.toDataURL('image/jpeg') }));
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

    #onOffsetChange(e) {
        this.#offset = parseInt(e.target.value);
        this.#onResize(document.getElementById("video"));
        this.#canvas.classList.add("cover");

        clearTimeout(this.offsetBackgroundTimer);
        this.offsetBackgroundTimer = setTimeout(() => {
            this.#canvas.classList.remove("cover");
        }, 750);

        localStorage.setItem("offset", this.#offset);
    }

    #onInsetChange(e) {
        this.#inset = parseInt(e.target.value);
        this.#onResize(document.getElementById("video"));
        this.#canvas.classList.add("cover");

        clearTimeout(this.offsetBackgroundTimer);
        this.offsetBackgroundTimer = setTimeout(() => {
            this.#canvas.classList.remove("cover");
        }, 750);

        localStorage.setItem("inset", this.#inset);
    }

    #onLineWidthChange(e) {
        this.#lineWidth = parseInt(e.target.value);
        localStorage.setItem("lineWidth", this.#lineWidth);
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

    #onResize(video) {
        const size = this.#getVideoDimensions(video);
        this.#scale = { x: size.width / video.videoWidth, y: size.height / video.videoHeight };

        const offset = this.#offset * this.#scale.y;
        const inset = this.#inset * this.#scale.x;

        this.#canvas.width = size.width - inset * 2;
        this.#canvas.height = size.height - (offset + this.#inset * this.#scale.y);
        this.#canvas.style.left = `${inset}px`;
        this.#canvas.style.top = `${offset / 2}px`;
        this.#canvasRect = this.#canvas.getBoundingClientRect();

        this.#context.scale(this.#scale.x, this.#scale.y);

        this.#sendData(JSON.stringify({
            action: "resize",
            width: size.width,
            height: size.height,
            videoWidth: video.videoWidth,
            videoHeight: video.videoHeight
        }));
    }

    #getVideoDimensions(video) {
        const videoRatio = video.videoWidth / video.videoHeight;
        let width = video.offsetWidth
        let height = video.offsetHeight;
        const elementRatio = width / height;

        if (elementRatio > videoRatio) {
            width = height * videoRatio;
        } else {
            height = width / videoRatio;
        }

        return { width, height };
    }

    #getX(e) {
        let x = e.pageX - this.#canvasRect.left;
        return x / this.#scale.x;
    }

    #getY(e) {
        let y = e.clientY - this.#canvasRect.top;
        return y / this.#scale.y;
    }

    /**
     * Sets the current drawing shape.
     * @param {string} shapeType - The type of shape to draw (e.g., "freehand", "arrow").
     */
    setShape(shapeType) {
        this.currentShape = shapeType;
        console.log("Current shape set to:", shapeType);
    }

    drawShape(shapeData) {
        const { shape, color, thickness } = shapeData;
        // Apply scaling to thickness for drawing, similar to local drawing
        const scaledThickness = thickness * 5 + 1; 

        this.#context.save(); // Save context state
        this.#context.strokeStyle = color;
        this.#context.fillStyle = color; // For filled shapes like arrowheads
        this.#context.lineWidth = scaledThickness;
        this.#context.lineCap = "round";
        this.#context.lineJoin = "round";

        switch (shape) {
            case "freehand":
                if (shapeData.points && shapeData.points.length > 1) {
                    this.#context.beginPath();
                    this.#context.moveTo(shapeData.points[0].x, shapeData.points[0].y);
                    for (let i = 1; i < shapeData.points.length; i++) {
                        this.#context.lineTo(shapeData.points[i].x, shapeData.points[i].y);
                    }
                    this.#context.stroke();
                } else if (shapeData.points && shapeData.points.length === 1) { // Draw a dot for single point freehand
                    this.#context.beginPath();
                    this.#context.arc(shapeData.points[0].x, shapeData.points[0].y, scaledThickness / 2, 0, Math.PI * 2);
                    this.#context.fill();
                }
                break;
            case "arrow":
                this._drawArrow(this.#context, shapeData.startX, shapeData.startY, shapeData.endX, shapeData.endY, color, scaledThickness);
                break;
            case "checkmark":
            case "x":
                this._drawMark(this.#context, shape, shapeData.centerX, shapeData.centerY, shapeData.scale, color, scaledThickness);
                break;
            default:
                console.warn("Unknown shape type received:", shape);
        }
        this.#context.restore(); // Restore context state

        // Add to undo stack after drawing remote shape
        this.#undoStack.push(this.#context.getImageData(0, 0, this.#canvas.width, this.#canvas.height));
        this.#undoIndex++;
        
        // Update OBS after drawing remote shape
        this.dispatchEvent(new CustomEvent('obsupdate', { detail: this.#canvas.toDataURL('image/jpeg') }));
    }


    // Helper methods for drawing shapes
    _drawArrow(ctx, fromX, fromY, toX, toY, color, thickness) {
        const headLengthFactor = 10; // Base head length
        // Adjust head length based on thickness, relative to a baseline thickness (e.g. 1)
        // This scaling needs to be consistent with how thickness is applied.
        // If thickness is original (1-10), and scaledThickness is (6-51),
        // we might want headLength to scale with original thickness.
        const headLength = headLengthFactor * (thickness / (this.#lineWidth * 5 +1) * 2);  // Example scaling, may need tuning
        // A simpler approach: make headLength proportional to the drawn line thickness
        // const headLength = 2 * thickness; // e.g. head is twice as long as line is thick
        // Or, if thickness is already scaled:
        // const headLength = 1.5 * thickness; // if thickness is scaledThickness
        // Let's assume thickness passed here IS the scaled one.
        const headLength = 1.5 * thickness;


        const dx = toX - fromX;
        const dy = toY - fromY;
        const angle = Math.atan2(dy, dx);

        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = thickness;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        ctx.beginPath();
        ctx.moveTo(fromX, fromY);
        ctx.lineTo(toX, toY);
        ctx.stroke(); // Draw the line part

        // Draw the arrowhead
        ctx.beginPath();
        ctx.moveTo(toX, toY);
        ctx.lineTo(toX - headLength * Math.cos(angle - Math.PI / 6), toY - headLength * Math.sin(angle - Math.PI / 6));
        ctx.lineTo(toX - headLength * Math.cos(angle + Math.PI / 6), toY - headLength * Math.sin(angle + Math.PI / 6));
        ctx.closePath();
        ctx.fillStyle = color; // Fill the arrowhead
        ctx.fill();
        ctx.restore();
    }

    _drawMark(ctx, shapeType, centerX, centerY, scale, color, thickness) {
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = thickness;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();

        const size = 20 * scale; // Base size for the mark, scaled

        if (shapeType === "checkmark") {
            // Path for checkmark: (points relative to centerX, centerY)
            // Adjust these points to make the checkmark appear centered on startPoint
            const points = [
                { x: -0.5 * size, y: 0 * size },
                { x: -0.1 * size, y: 0.4 * size },
                { x: 0.5 * size, y: -0.4 * size }
            ];
            ctx.moveTo(centerX + points[0].x, centerY + points[0].y);
            ctx.lineTo(centerX + points[1].x, centerY + points[1].y);
            ctx.lineTo(centerX + points[2].x, centerY + points[2].y);
        } else if (shapeType === "x") {
            // Path for X: (two lines, centered on startPoint)
            const halfSize = 0.5 * size;
            ctx.moveTo(centerX - halfSize, centerY - halfSize);
            ctx.lineTo(centerX + halfSize, centerY + halfSize);
            ctx.moveTo(centerX + halfSize, centerY - halfSize);
            ctx.lineTo(centerX - halfSize, centerY + halfSize);
        }
        ctx.stroke();
        ctx.restore();
    }
}