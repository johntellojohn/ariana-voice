const wrtc = require("@roamhq/wrtc");

const env = require("../../config/env");

const { RTCAudioSink, RTCAudioSource } = wrtc.nonstandard;

class InternalWebRtcBridgeSession {
    constructor(payload, options = {}) {
        this.sessionId = options.sessionId;
        this.baseUrl = options.baseUrl;
        this.onClosed = options.onClosed || null;
        this.callId = payload.call_id || payload.callId;
        this.tenantId = payload.tenant_id || payload.tenantId || payload.tenant || null;
        this.callerOfferSdp = normalizeRemoteSdp(payload.caller_offer_sdp || payload.offer_sdp || payload.sdp);

        this.createdAt = new Date();
        this.closedAt = null;
        this.status = "created";

        this.callerPc = null;
        this.calleePc = null;

        this.callerAudioSource = null;
        this.callerOutboundTrack = null;
        this.callerSink = null;

        this.calleeAudioSource = null;
        this.calleeOutboundTrack = null;
        this.calleeSink = null;

        this.callerFramesReceived = 0;
        this.calleeFramesReceived = 0;

        this.calleeConnectTimeout = null;
        this.lastActivityAt = Date.now();
        this.lastActivityType = "created";
    }

    async start() {
        if (!this.callerOfferSdp || !this.callerOfferSdp.startsWith("v=0")) {
            const error = new Error("caller_offer_sdp must be a valid SDP offer");
            error.status = 422;
            throw error;
        }

        this.status = "starting";
        const iceServers = getIceServers();

        this.callerPc = new wrtc.RTCPeerConnection({
            iceServers,
        });

        this.callerPc.ontrack = (event) => this.handleCallerTrack(event.track);
        this.callerPc.onconnectionstatechange = () => this.handlePeerState("caller", this.callerPc.connectionState);
        this.callerPc.oniceconnectionstatechange = () => this.handleIceState("caller", this.callerPc.iceConnectionState);

        await this.callerPc.setRemoteDescription(
            new wrtc.RTCSessionDescription({
                type: "offer",
                sdp: this.callerOfferSdp,
            })
        );

        await this.setupCallerOutboundAudio();

        const answer = await this.callerPc.createAnswer();
        await this.callerPc.setLocalDescription(answer);
        await waitForIceGatheringComplete(this.callerPc, env.webrtcIceGatherTimeoutMs);

        this.status = "caller_answer_ready";
        this.markActivity("caller_answer_ready");
        this.log("internal bridge caller answer_sdp ready", {
            answer_sdp_bytes: this.callerPc.localDescription.sdp.length,
        });

        // Timeout si el callee nunca se conecta tras 120 segundos
        this.calleeConnectTimeout = setTimeout(() => {
            if (!this.calleePc && !this.closedAt) {
                this.log("internal bridge timeout waiting for callee connection");
                this.close("callee_timeout").catch(() => {});
            }
        }, 120000);

        return this.callerPc.localDescription.sdp;
    }

    async setupCallerOutboundAudio() {
        this.callerAudioSource = new RTCAudioSource();
        this.callerOutboundTrack = this.callerAudioSource.createTrack();

        const transceiver = findAudioTransceiver(this.callerPc);

        if (transceiver && transceiver.sender) {
            await transceiver.sender.replaceTrack(this.callerOutboundTrack);

            try {
                transceiver.direction = "sendrecv";
            } catch (error) {
                this.log("could not force caller transceiver direction", {
                    error: error.message,
                });
            }
        } else {
            this.callerPc.addTrack(this.callerOutboundTrack);
        }
    }

    handleCallerTrack(track) {
        if (track.kind !== "audio") {
            return;
        }

        if (this.callerSink) {
            this.callerSink.stop();
        }

        this.callerSink = new RTCAudioSink(track);
        this.callerSink.ondata = (data) => {
            if (this.closedAt) {
                return;
            }

            this.callerFramesReceived += 1;
            this.markActivity("caller_audio");

            if (this.calleeAudioSource) {
                this.calleeAudioSource.onData(data);
            }
        };

        this.status = "caller_connected";
        this.log("internal bridge caller audio track attached", {
            track_id: track.id,
            ready_state: track.readyState,
        });

        track.onended = () => {
            this.log("internal bridge caller track ended");
        };
    }

    async connectCallee(calleeOfferSdp, options = {}) {
        calleeOfferSdp = normalizeRemoteSdp(calleeOfferSdp);

        if (!calleeOfferSdp || !calleeOfferSdp.startsWith("v=0")) {
            const error = new Error("callee_offer_sdp must be a valid SDP offer");
            error.status = 422;
            throw error;
        }

        if (!this.callerPc || this.closedAt) {
            const error = new Error("Internal WebRTC bridge session is not active");
            error.status = 409;
            throw error;
        }

        if (this.calleeConnectTimeout) {
            clearTimeout(this.calleeConnectTimeout);
            this.calleeConnectTimeout = null;
        }

        await this.closeCalleePeer("callee_replaced");

        const iceServers = getIceServers();
        this.calleePc = new wrtc.RTCPeerConnection({
            iceServers,
        });

        this.calleePc.ontrack = (event) => this.handleCalleeTrack(event.track);
        this.calleePc.onconnectionstatechange = () => this.handlePeerState("callee", this.calleePc.connectionState);
        this.calleePc.oniceconnectionstatechange = () => this.handleIceState("callee", this.calleePc.iceConnectionState);

        try {
            await this.calleePc.setRemoteDescription(
                new wrtc.RTCSessionDescription({
                    type: "offer",
                    sdp: calleeOfferSdp,
                })
            );
        } catch (error) {
            this.log("internal bridge callee offer_sdp rejected", {
                error: error.message,
                sdp: summarizeSdp(calleeOfferSdp),
            });

            await this.closeCalleePeer("callee_offer_rejected");
            throw error;
        }

        await this.setupCalleeOutboundAudio();

        const answer = await this.calleePc.createAnswer();
        await this.calleePc.setLocalDescription(answer);
        await waitForIceGatheringComplete(this.calleePc, env.webrtcIceGatherTimeoutMs);

        this.status = "callee_connected";
        this.markActivity("callee_answer_ready");
        this.log("internal bridge callee answer_sdp ready", {
            answer_sdp_bytes: this.calleePc.localDescription.sdp.length,
        });

        return {
            callee_answer_sdp: this.calleePc.localDescription.sdp,
            snapshot: this.snapshot(),
        };
    }

    async setupCalleeOutboundAudio() {
        this.calleeAudioSource = new RTCAudioSource();
        this.calleeOutboundTrack = this.calleeAudioSource.createTrack();

        const transceiver = findAudioTransceiver(this.calleePc);

        if (transceiver && transceiver.sender) {
            await transceiver.sender.replaceTrack(this.calleeOutboundTrack);

            try {
                transceiver.direction = "sendrecv";
            } catch (error) {
                this.log("could not force callee transceiver direction", {
                    error: error.message,
                });
            }
        } else {
            this.calleePc.addTrack(this.calleeOutboundTrack);
        }
    }

    handleCalleeTrack(track) {
        if (track.kind !== "audio") {
            return;
        }

        if (this.calleeSink) {
            this.calleeSink.stop();
        }

        this.calleeSink = new RTCAudioSink(track);
        this.calleeSink.ondata = (data) => {
            if (this.closedAt) {
                return;
            }

            this.calleeFramesReceived += 1;
            this.markActivity("callee_audio");

            if (this.callerAudioSource) {
                this.callerAudioSource.onData(data);
            }
        };

        this.status = "both_connected";
        this.log("internal bridge callee audio track attached", {
            track_id: track.id,
            ready_state: track.readyState,
        });

        track.onended = () => {
            this.log("internal bridge callee track ended");
        };
    }

    handlePeerState(peer, state) {
        this.log(`internal bridge ${peer} peer state`, { peer, state });

        if (["failed", "closed"].includes(state) && !this.closedAt) {
            if (peer === "caller" || (peer === "callee" && this.status === "both_connected")) {
                this.close(`${peer}_peer_${state}`).catch((error) => {
                    console.error(`Error closing internal bridge after ${peer} peer state`, error);
                });
            }
        }
    }

    handleIceState(peer, state) {
        this.log(`internal bridge ${peer} ice state`, { peer, state });

        if (["failed", "closed"].includes(state) && !this.closedAt) {
            if (peer === "caller" || (peer === "callee" && this.status === "both_connected")) {
                this.close(`${peer}_ice_${state}`).catch((error) => {
                    console.error(`Error closing internal bridge after ${peer} ice state`, error);
                });
            }
        }
    }

    async closeCalleePeer(reason = "callee_closed") {
        if (this.calleeSink) {
            this.calleeSink.stop();
            this.calleeSink = null;
        }

        if (this.calleeOutboundTrack) {
            this.calleeOutboundTrack.stop();
            this.calleeOutboundTrack = null;
        }

        if (this.calleePc) {
            this.calleePc.ontrack = null;
            this.calleePc.onconnectionstatechange = null;
            this.calleePc.oniceconnectionstatechange = null;
            this.calleePc.close();
            this.calleePc = null;
        }

        this.calleeAudioSource = null;
        this.markActivity(reason);
    }

    async close(reason = "closed") {
        if (this.closedAt) {
            return;
        }

        this.closedAt = new Date();
        this.status = "closed";

        if (this.calleeConnectTimeout) {
            clearTimeout(this.calleeConnectTimeout);
            this.calleeConnectTimeout = null;
        }

        await this.closeCalleePeer(reason);

        if (this.callerSink) {
            this.callerSink.stop();
            this.callerSink = null;
        }

        if (this.callerOutboundTrack) {
            this.callerOutboundTrack.stop();
            this.callerOutboundTrack = null;
        }

        if (this.callerPc) {
            this.callerPc.ontrack = null;
            this.callerPc.onconnectionstatechange = null;
            this.callerPc.oniceconnectionstatechange = null;
            this.callerPc.close();
            this.callerPc = null;
        }

        this.callerAudioSource = null;
        this.markActivity(reason);
        this.log("internal bridge closed", {
            reason,
            caller_frames_received: this.callerFramesReceived,
            callee_frames_received: this.calleeFramesReceived,
        });

        if (typeof this.onClosed === "function") {
            this.onClosed(this);
        }
    }

    markActivity(type) {
        this.lastActivityAt = Date.now();
        this.lastActivityType = type;
    }

    snapshot() {
        return {
            session_id: this.sessionId,
            call_id: this.callId,
            tenant_id: this.tenantId,
            mode: "internal_webrtc_bridge",
            status: this.status,
            created_at: this.createdAt ? this.createdAt.toISOString() : null,
            closed_at: this.closedAt ? this.closedAt.toISOString() : null,
            last_activity_at: new Date(this.lastActivityAt).toISOString(),
            last_activity_type: this.lastActivityType,
            caller_frames_received: this.callerFramesReceived,
            callee_frames_received: this.calleeFramesReceived,
            has_caller_peer: Boolean(this.callerPc),
            has_callee_peer: Boolean(this.calleePc),
        };
    }

    log(message, data = {}) {
        console.log(
            `[internal-bridge:${this.sessionId} call_id:${this.callId}] ${message}`,
            JSON.stringify(data)
        );
    }
}

function getIceServers() {
    if (Array.isArray(env.webrtcIceServers) && env.webrtcIceServers.length > 0) {
        return env.webrtcIceServers;
    }

    return [{ urls: "stun:stun.l.google.com:19302" }];
}

function findAudioTransceiver(pc) {
    return pc
        .getTransceivers()
        .find((transceiver) => {
            const receiverTrack = transceiver.receiver && transceiver.receiver.track;
            const senderTrack = transceiver.sender && transceiver.sender.track;

            return (
                (receiverTrack && receiverTrack.kind === "audio") ||
                (senderTrack && senderTrack.kind === "audio")
            );
        });
}

async function waitForIceGatheringComplete(pc, timeoutMs = 3000) {
    if (pc.iceGatheringState === "complete") {
        return;
    }

    await new Promise((resolve) => {
        const timeout = setTimeout(() => {
            pc.removeEventListener("icegatheringstatechange", handleChange);
            resolve();
        }, timeoutMs);

        const handleChange = () => {
            if (pc.iceGatheringState !== "complete") {
                return;
            }

            clearTimeout(timeout);
            pc.removeEventListener("icegatheringstatechange", handleChange);
            resolve();
        };

        pc.addEventListener("icegatheringstatechange", handleChange);
    });
}

function normalizeRemoteSdp(sdp) {
    const normalized = String(sdp || "")
        .replace(/\\r\\n/g, "\r\n")
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\r\n|\r|\n/g, "\r\n")
        .split("\r\n")
        .filter((line) => line.trim() !== "")
        .filter((line) => line.trim() !== "a=extmap-allow-mixed")
        .join("\r\n")
        .trimStart()
        .replace(/(?:\r\n)+$/g, "");

    return normalized === "" ? "" : `${normalized}\r\n`;
}

function summarizeSdp(sdp) {
    const lines = String(sdp || "").split(/\r\n|\r|\n/);
    const invalidLines = lines
        .map((line, index) => ({ line: index + 1, text: line.slice(0, 140) }))
        .filter((entry) => entry.text !== "" && !/^[a-z]=/.test(entry.text))
        .slice(0, 10);

    return {
        bytes: Buffer.byteLength(String(sdp || "")),
        lines: lines.length,
        first_line: lines[0] ? lines[0].slice(0, 80) : "",
        has_extmap_allow_mixed: lines.some((line) => line.trim() === "a=extmap-allow-mixed"),
        invalid_lines: invalidLines,
    };
}

module.exports = InternalWebRtcBridgeSession;

