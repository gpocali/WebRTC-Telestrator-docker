class DrawingControls extends EventTarget {
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
    // /** @type {{x: number, y:number}} */
    // #scale; // Removed as canvas is now fixed resolution
    /** @type {PointerEvent} */
    #firstPointer;
    /** @type {ImageData[]} */
    #undoStack = [];
    #undoIndex = -1;
    #lineColor = "black";
    #lineWidth = 1;
    #isDrawing = false;
    #hasCanvasChanged = false;
    #frameTimeout = null;
    currentShape = "freehand"; // Default shape

    // Properties for shape drawing
    // #isDrawing is already defined
    startPoint = { x: 0, y: 0 };
    currentEndPoint = { x: 0, y: 0 }; // For arrow preview
    lastDrawnPreview = null; // Stores ImageData to clear previous preview
    freehandPoints = []; // For accumulating points for a freehand stroke
    currentShapeBaseSize = 1; // Default base size, will be updated

    /**
     * Create an instance of the drawing controls
     * @param {boolean} isDebugMode 
     */
    constructor(isDebugMode) {
        super(); // Add this line
        this.currentShapeBaseSize = this.#lineWidth; // Initialize with current lineWidth
        this.obsUpdateTimeout = null;
        this.obsUpdateInterval = 33; // ms, for throttling (approx 30 FPS)
        // Create the canvas context
        this.#canvas = document.getElementById("canvas");
        this.#context = this.#canvas.getContext("2d", { willReadFrequently: true });

        // Set fixed canvas resolution
        this.#canvas.width = 1920;
        this.#canvas.height = 1080;

        // Listen to pointer events for drawing
        this.#canvas.addEventListener("pointerdown", (e) => this.#onStart(e));
        this.#canvas.addEventListener("pointermove", (e) => this.#onMove(e));
        this.#canvas.addEventListener("pointerup", (e) => this.#onStop(e));
        this.#canvas.addEventListener("pointerout", (e) => this.#onStop(e));

        // Load settings
        // const loadedOffset = localStorage.getItem("offset");
        // if (typeof loadedOffset === "string") {
        //     this.#offset = parseInt(loadedOffset);
        // }
        // const offsetControl = document.getElementById("offsetV"); // Changed ID
        // if (offsetControl) { // Add null check for safety
        //     offsetControl.addEventListener("change", (e) => this.#onOffsetChange(e));
        //     offsetControl.value = this.#offset;
        // }

        // const loadedInset = localStorage.getItem("inset");
        // if (typeof loadedInset === "string") {
        //     this.#inset = parseInt(loadedInset);
        // }
        // const insetControl = document.getElementById("insetH"); // Changed ID
        // if (insetControl) { // Add null check for safety
        //     insetControl.addEventListener("change", (e) => this.#onInsetChange(e));
        //     insetControl.value = this.#inset;
        // }

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
        // video.classList.remove("hide"); // Removed, parent #mediaStage will be shown
        document.getElementById("connection").classList.add("hide");
        // document.getElementById("drawing").classList.remove("hide"); // Removed, parent #mediaStage will be shown
        document.getElementById("mediaStage").classList.remove("hide");

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
    this.dispatchEvent(new CustomEvent('obsupdate', { detail: this.#canvas.toDataURL('image/png') })); // Or png
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
            this._throttledObsUpdate();
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
            this._throttledObsUpdate();
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

        const finalLineWidth = this.#lineWidth * 5 + 1; // Consistent thickness

        // Restore canvas to state before preview drawing started for shapes
        if (this.currentShape !== "freehand" && this.lastDrawnPreview) {
            this.#context.putImageData(this.lastDrawnPreview, 0, 0);
        }
        // Note: No full canvas clear here anymore. Any diagnostic dispatch also removed.

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
        this.dispatchEvent(new CustomEvent('obsupdate', { detail: this.#canvas.toDataURL('image/png') }));


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
            data.centerX = this.startPoint.x; 
            data.centerY = this.startPoint.y; 
            
            const distance = Math.sqrt(dx * dx + dy * dy);
            const tapThreshold = 5; // Pixels of movement to still be considered a tap

            if (distance < tapThreshold) {
                // It's a tap, use lineWidth to determine initial scale
                data.scale = (this.currentShapeBaseSize + 1) * 0.8; // Changed 0.2 to 0.8
            } else {
                // It's a drag, use distance to determine scale
                data.scale = distance / 50; 
            }
            // Ensure scale is not zero if distance was exactly tapThreshold or slightly more but resulted in 0 scale
            // Also update the fallback to use the new multiplier
            if (data.scale === 0) data.scale = (this.currentShapeBaseSize + 1) * 0.8; // Changed 0.2 to 0.8
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
            this.dispatchEvent(new CustomEvent('obsupdate', { detail: this.#canvas.toDataURL('image/png') }));
        }
        this.lastDrawnPreview = null; // Clear any preview state
        e.preventDefault();
        return false;
    }

    #onClear(e) {
        this.#context.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
        const clearedImageData = this.#context.getImageData(0, 0, this.#canvas.width, this.#canvas.height);
        this.#undoStack = [clearedImageData];
        this.#undoIndex = 0;
        this.lastDrawnPreview = null;
        this.dispatchEvent(new CustomEvent('obsupdate', { detail: this.#canvas.toDataURL('image/png') }));

        setTimeout(() => {
            this.dispatchEvent(new CustomEvent('obsupdate', { detail: this.#canvas.toDataURL('image/png') }));
        }, 50); // Using 50ms as a delay

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

    // #onOffsetChange(e) method removed (as per previous step and this one)

    // #onInsetChange(e) method removed (as per previous step and this one)

    #onLineWidthChange(e) {
        this.#lineWidth = parseInt(e.target.value);
        this.currentShapeBaseSize = this.#lineWidth; // Update base size
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

    #onResize(video) { // video parameter might become unused or less relevant for canvas buffer size
        if (!this.#canvas) return; 
        
        // Update canvasRect for mouse coordinate calculations.
        // The canvas buffer is fixed at 1920x1080.
        // CSS will handle the visual scaling of the canvas element.
        this.#canvasRect = this.#canvas.getBoundingClientRect();
        
        // No more canvas.width/height changes here based on video or parent size.
        // No more context.setTransform() or context.scale() here. The context operates on the 1920x1080 buffer.

        // Dispatch an obsupdate event. This is important if, for example,
        // the canvas was cleared and needs to reflect that, or if other UI changes
        // related to resize need to trigger an update of the (now fixed-size) canvas.
        this.dispatchEvent(new CustomEvent('obsupdate', { detail: this.#canvas.toDataURL('image/png') }));
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
        // e.pageX is the mouse position relative to the document.
        // this.#canvasRect.left is the canvas's left offset from the document's left.
        // (e.pageX - this.#canvasRect.left) is the mouse X relative to the CSS-scaled canvas.
        // We then scale this up to the 1920px buffer width.
        let x = (e.pageX - this.#canvasRect.left) * (this.#canvas.width / this.#canvasRect.width);
        return x;
    }

    #getY(e) {
        // e.clientY is the mouse position relative to the document.
        // this.#canvasRect.top is the canvas's top offset from the document's top.
        // (e.clientY - this.#canvasRect.top) is the mouse Y relative to the CSS-scaled canvas.
        // We then scale this up to the 1080px buffer height.
        let y = (e.clientY - this.#canvasRect.top) * (this.#canvas.height / this.#canvasRect.height);
        return y;
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
        this.dispatchEvent(new CustomEvent('obsupdate', { detail: this.#canvas.toDataURL('image/png') }));
    }


    // Helper methods for drawing shapes
    _drawArrow(ctx, fromX, fromY, toX, toY, color, thickness) {
        const headLengthFactor = 10; // Base head length
        // Adjust head length based on thickness, relative to a baseline thickness (e.g. 1)
        // This scaling needs to be consistent with how thickness is applied.
        // If thickness is original (1-10), and scaledThickness is (6-51),
        // we might want headLength to scale with original thickness.
        // const headLength = headLengthFactor * (thickness / (this.#lineWidth * 5 +1) * 2);  // Example scaling, may need tuning
        // A simpler approach: make headLength proportional to the drawn line thickness
        // const headLength = 2 * thickness; // e.g. head is twice as long as line is thick
        // Or, if thickness is already scaled:
        // const headLength = 1.5 * thickness; // if thickness is scaledThickness
        // Let's assume thickness passed here IS the scaled one.
        const headLength = 6 * thickness; // Increased headLength


        const dx = toX - fromX;
        const dy = toY - fromY;
        const angle = Math.atan2(dy, dx);

        // Calculate the point where the line should visually end to be covered by the arrowhead
        const lineShortenAmount = thickness / 2.5; // Shorten by a bit less than half thickness to ensure overlap
                                                  // This value might need tuning.
        const lineToX = toX - Math.cos(angle) * lineShortenAmount;
        const lineToY = toY - Math.sin(angle) * lineShortenAmount;

        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = thickness;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        ctx.beginPath();
        ctx.moveTo(fromX, fromY);
        // Use the new shortened line end points
        if (Math.sqrt(dx*dx + dy*dy) > lineShortenAmount) { // Only shorten if line is long enough
            ctx.lineTo(lineToX, lineToY);
        } else { // Line is too short to shorten, draw to original end
            ctx.lineTo(toX, toY);
        }
        ctx.stroke(); // Draw the (potentially shortened) line part

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

    _throttledObsUpdate() {
        if (this.obsUpdateTimeout) {
            clearTimeout(this.obsUpdateTimeout);
        }
        this.obsUpdateTimeout = setTimeout(() => {
            this.dispatchEvent(new CustomEvent('obsupdate', { detail: this.#canvas.toDataURL('image/png') }));
            this.obsUpdateTimeout = null;
        }, this.obsUpdateInterval);
    }
}