class WebConnection extends EventTarget {
    /** @type {MediaStream} */
    #stream; // Stores the host's local display media
    #id = ""; // WebConnection's own unique ID for signaling
    #isHost = false;
    peerConnections = new Map(); // Stores RTCPeerConnection objects, keyed by client ID

    constructor() {
        super();
        // Generate a unique ID for this WebConnection instance (used by host for declare_host)
        this.#id = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
    }

    get id() {
        return this.#id;
    }

    get isHost() {
        return this.#isHost;
    }

    /**
     * Initialize the WebConnection instance.
     * For hosts, it acquires the display media.
     * For clients, it prepares to receive an offer.
     * @param {boolean} asHost True if this is the hosting peer
     */
    async create(asHost) {
        this.#isHost = asHost;

        if (this.#isHost) {
            try {
                this.#stream = await navigator.mediaDevices.getDisplayMedia({
                    video: {
                        displaySurface: "window",
                    },
                    audio: false, // Assuming no audio for simplicity
                });
                // Display host's own stream locally
                const videoElement = document.getElementById("video");
                if (videoElement) {
                    videoElement.autoplay = true;
                    videoElement.srcObject = this.#stream;
                    videoElement.classList.remove("hide");
                }
                console.log("Host: Display media acquired.");
                this.dispatchEvent(new CustomEvent("streamacquired")); // Notify UI if needed
            } catch (error) {
                console.error("Host: Error acquiring display media:", error);
                this.dispatchEvent(new CustomEvent("streamerror", { detail: error }));
                return; // Stop if stream acquisition fails
            }
        } else {
            // Client-side initialization (will be expanded in Phase 3)
            // For now, clients mainly wait for offers.
            // The ontrack event for clients would be set up after creating a PC
            // when handling an offer.
            const videoElement = document.getElementById("video");
            if (videoElement) {
                 videoElement.classList.remove("hide"); // Show video element for client
            }
        }
    }

    /**
     * Called when the host receives a 'client_requesting_offer' signal.
     * Creates a new RTCPeerConnection for the requesting client.
     * @param {string} requestingClientId The ID of the client requesting the offer.
     */
    async handleClientRequest(requestingClientId) {
        if (!this.#isHost || !this.#stream) {
            console.error("Host: Cannot handle client request without being a host or without a stream.");
            return;
        }

        console.log(`Host: Handling offer request from client ${requestingClientId}`);
        const rtc = RTCPeerConnection ?? webkitRTCPeerConnection;
        const pc = new rtc(webRTCConfig); // webRTCConfig should be defined globally or passed

        this.peerConnections.set(requestingClientId, pc);

        for (const track of this.#stream.getTracks()) {
            pc.addTrack(track, this.#stream);
        }

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                this._dispatchSignalEvent("candidate", { toId: requestingClientId, candidate: e.candidate });
            }
        };
        
        // For host, ontrack would be for receiving client's stream (if bidirectional)
        // pc.ontrack = (e) => { ... }; 

        // Data channel (optional, simplified for now)
        // If data channels are needed per client:
        // const dataChannel = pc.createDataChannel(`dc_${requestingClientId}`);
        // this._setupDataChannelEvents(dataChannel, requestingClientId);

        try {
            const offer = await pc.createOffer({
                offerToReceiveAudio: false, // Assuming host only sends video
                offerToReceiveVideo: true,
            });
            await pc.setLocalDescription(offer);
            this._dispatchSignalEvent("offer", { toId: requestingClientId, sdp: offer });
            console.log(`Host: Sent offer to client ${requestingClientId}`);
        } catch (error) {
            console.error(`Host: Error creating offer for ${requestingClientId}:`, error);
        }
    }

    /**
     * Handles an "answer" received from a client.
     * @param {string} fromId The ID of the client that sent the answer.
     * @param {RTCSessionDescriptionInit} answerSdp The SDP of the answer.
     */
    async handleAnswer(fromId, answerSdp) {
        const pc = this.peerConnections.get(fromId);
        if (!pc) {
            console.error(`Host: No peer connection found for client ${fromId} to handle answer.`);
            return;
        }
        try {
            await pc.setRemoteDescription(new RTCSessionDescription(answerSdp));
            console.log(`Host: Set remote description (answer) from client ${fromId}`);
             // Connection established with this client.
            this.dispatchEvent(new CustomEvent("clientconnected", { detail: { clientId: fromId } }));
        } catch (error) {
            console.error(`Host: Error setting remote description for ${fromId}:`, error);
        }
    }

    /**
     * Handles an ICE candidate received from a client or host.
     * @param {string} fromId The ID of the peer that sent the candidate.
     * @param {RTCIceCandidateInit} candidate The ICE candidate.
     */
    async handleCandidate(fromId, candidate) {
        // For host, fromId is the client's ID.
        // For client, fromId is the host's ID.
        const pc = this.#isHost ? this.peerConnections.get(fromId) : this.peerConnections.get("host"); // Client logic placeholder

        if (!pc) {
            console.error(`Peer connection not found for ${fromId} to handle ICE candidate.`);
            return;
        }
        try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (error) {
            console.error(`Error adding ICE candidate from ${fromId}:`, error);
        }
    }
    
    /**
     * Handles an "offer" received from the host (Client-side logic).
     * @param {string} fromId The ID of the host that sent the offer.
     * @param {RTCSessionDescriptionInit} offerSdp The SDP of the offer.
     */
    async handleOffer(fromId, offerSdp) {
        if (this.#isHost) {
            console.warn("Host received an offer, this should not happen in current flow.");
            return;
        }

        console.log(`Client: Received offer from host ${fromId}`);
        const rtc = RTCPeerConnection ?? webkitRTCPeerConnection;
        // Assuming one PC for the client, connected to the host.
        const pc = new rtc(webRTCConfig);
        this.peerConnections.set("host", pc); // Store client's PC, keyed as "host"

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                this._dispatchSignalEvent("candidate", { toId: fromId, candidate: e.candidate });
            }
        };

        pc.ontrack = (e) => {
            const videoElement = document.getElementById("video");
            if (videoElement) {
                if (!videoElement.srcObject || videoElement.srcObject.id !== e.streams[0].id) {
                    videoElement.srcObject = e.streams[0];
                    videoElement.autoplay = true;
                    videoElement.classList.remove("hide");
                    console.log("Client: Video stream received and playing.");
                    // Dispatch event that client is connected and streaming
                    this.dispatchEvent(new CustomEvent("connected", { detail: { /* can pass dataChannel if created */ } }));
                }
            }
        };
        
        // If client needs to send data channel (e.g. for drawing back to host)
        // const dataChannel = pc.createDataChannel("client_dc");
        // this._setupDataChannelEvents(dataChannel, "host");


        try {
            await pc.setRemoteDescription(new RTCSessionDescription(offerSdp));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            this._dispatchSignalEvent("answer", { toId: fromId, sdp: answer });
            console.log(`Client: Sent answer to host ${fromId}`);
        } catch (error) {
            console.error("Client: Error handling offer or creating answer:", error);
        }
    }


    _dispatchSignalEvent(type, payload) {
        this.dispatchEvent(new CustomEvent("signal", { detail: { type, payload } }));
    }

    // Placeholder for data channel setup, if needed per client
    _setupDataChannelEvents(dataChannel, peerId) {
        dataChannel.onopen = () => {
            console.log(`Data channel with ${peerId} opened.`);
            // For host, might enable drawing controls for this client if applicable
            // For client, might mean connection is fully ready
             if (!this.#isHost) { // Client connected to host
                this.dispatchEvent(new CustomEvent("connected", { detail: dataChannel }));
             }
        };
        dataChannel.onmessage = (event) => {
            console.log(`Data channel message from ${peerId}:`, event.data);
            // Dispatch event for main.js to handle drawing data or other messages
            this.dispatchEvent(new CustomEvent("datamessage", { detail: { from: peerId, data: event.data } }));
        };
        dataChannel.onclose = () => {
            console.log(`Data channel with ${peerId} closed.`);
        };
        dataChannel.onerror = (error) => {
            console.error(`Data channel error with ${peerId}:`, error);
        };
    }
    
    closeConnection(peerId) {
        const pc = this.peerConnections.get(peerId);
        if (pc) {
            pc.close();
            this.peerConnections.delete(peerId);
            console.log(`Closed connection with ${peerId}`);
        }
    }

    closeAllConnections() {
        this.peerConnections.forEach((pc, peerId) => {
            pc.close();
            console.log(`Closed connection with ${peerId}`);
        });
        this.peerConnections.clear();
        if (this.#stream) {
            this.#stream.getTracks().forEach(track => track.stop());
            this.#stream = null;
        }
        const videoElement = document.getElementById("video");
        if (videoElement) {
            videoElement.srcObject = null;
            videoElement.classList.add("hide");
        }
        console.log("All connections closed and stream released.");
    }


    // Original methods like onOffer, onIceCandidate, onAnswer are replaced by 
    // handleOffer, handleCandidate, handleAnswer to better reflect the new flow.
    // #createDataChannelForCanvas is removed; data channels are per-client if needed.
    // #sendToWebSocket is replaced by _dispatchSignalEvent.
    // #display and #log can remain if they are used for generic event dispatching.

    #display(e) { // This seems to be for displaying data from a data channel.
        this.dispatchEvent(new CustomEvent("display", { detail: e.data }));
    }

    #log(data) {
        this.dispatchEvent(new CustomEvent("log", { detail: data }));
    }
}