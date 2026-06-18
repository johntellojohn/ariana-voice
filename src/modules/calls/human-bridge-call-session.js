const wrtc = require("@roamhq/wrtc");

const env = require("../../config/env");

const { RTCAudioSink, RTCAudioSource } = wrtc.nonstandard;

class HumanBridgeCallSession {
    constructor(payload, options = {}) {
        this.sessionId = options.sessionId;
        this.baseUrl = options.baseUrl;
        this.onClosed = options.onClosed || null;
        this.callId = payload.call_id;
        this.phoneNumberId = payload.phone_number_id;
        this.offerSdp = payload.offer_sdp;
        this.tenant = payload.tenant || null;
        this.agentId = payload.agent_id || null;
        this.createdAt = new Date();
        this.closedAt = null;
        this.status = "created";

        this.metaPc = null;
        this.agentPc = null;
        this.metaAudioSource = null;
        this.agentAudioSource = null;
        this.metaOutboundTrack = null;
        this.agentOutboundTrack = null;
        this.metaSink = null;
        this.agentSink = null;
        this.metaFramesReceived = 0;
        this.agentFramesReceived = 0;
        this.activeAgentId = null;
        this.lastActivityAt = Date.now();
        this.lastActivityType = "created";
    }

    async start() {
        this.status = "starting";
        this.metaPc = new wrtc.RTCPeerConnection({
            iceServers: env.webrtcIceServers,
        });

        this.metaPc.ontrack = (event) => this.handleMetaTrack(event.track);
        this.metaPc.onconnectionstatechange = () => this.handlePeerState("meta", this.metaPc.connectionState);
        this.metaPc.oniceconnectionstatechange = () => this.handleIceState("meta", this.metaPc.iceConnectionState);

        await this.metaPc.setRemoteDescription(
            new wrtc.RTCSessionDescription({
                type: "offer",
                sdp: this.offerSdp,
            })
        );

        await this.setupMetaOutboundAudio();

        const answer = await this.metaPc.createAnswer();
        await this.metaPc.setLocalDescription(answer);
        await waitForIceGatheringComplete(this.metaPc, env.webrtcIceGatherTimeoutMs);

        this.status = "answer_ready";
        this.markActivity("meta_answer_ready");
        this.log("human bridge meta answer_sdp ready", {
            answer_sdp_bytes: this.metaPc.localDescription.sdp.length,
        });

        return this.metaPc.localDescription.sdp;
    }

    async setupMetaOutboundAudio() {
        this.metaAudioSource = new RTCAudioSource();
        this.metaOutboundTrack = this.metaAudioSource.createTrack();

        const transceiver = findAudioTransceiver(this.metaPc);

        if (transceiver && transceiver.sender) {
            await transceiver.sender.replaceTrack(this.metaOutboundTrack);

            try {
                transceiver.direction = "sendrecv";
            } catch (error) {
                this.log("could not force meta transceiver direction", {
                    error: error.message,
                });
            }
        } else {
            this.metaPc.addTrack(this.metaOutboundTrack);
        }
    }

    handleMetaTrack(track) {
        if (track.kind !== "audio") {
            return;
        }

        if (this.metaSink) {
            this.metaSink.stop();
        }

        this.metaSink = new RTCAudioSink(track);
        this.metaSink.ondata = (data) => {
            if (this.closedAt) {
                return;
            }

            this.metaFramesReceived += 1;
            this.markActivity("meta_audio");

            if (this.agentAudioSource) {
                this.agentAudioSource.onData(data);
            }
        };

        this.status = "meta_connected";
        this.log("human bridge meta audio track attached", {
            track_id: track.id,
            ready_state: track.readyState,
        });

        track.onended = () => {
            this.close("meta_track_ended").catch((error) => {
                console.error("Error closing human bridge on meta track end", error);
            });
        };
    }

    async connectAgent(agentOfferSdp, options = {}) {
        agentOfferSdp = normalizeRemoteSdp(agentOfferSdp);

        if (!agentOfferSdp.startsWith("v=0")) {
            const error = new Error("agent offer_sdp must be a valid SDP offer");
            error.status = 422;
            throw error;
        }

        if (!this.metaPc || this.closedAt) {
            const error = new Error("Human bridge session is not active");
            error.status = 409;
            throw error;
        }

        await this.closeAgentPeer("agent_replaced");

        this.agentPc = new wrtc.RTCPeerConnection({
            iceServers: env.webrtcIceServers,
        });
        this.activeAgentId = options.agent_id || options.agentId || null;
        this.agentAudioSource = new RTCAudioSource();
        this.agentOutboundTrack = this.agentAudioSource.createTrack();

        this.agentPc.ontrack = (event) => this.handleAgentTrack(event.track);
        this.agentPc.onconnectionstatechange = () => this.handlePeerState("agent", this.agentPc.connectionState);
        this.agentPc.oniceconnectionstatechange = () => this.handleIceState("agent", this.agentPc.iceConnectionState);

        try {
            await this.agentPc.setRemoteDescription(
                new wrtc.RTCSessionDescription({
                    type: "offer",
                    sdp: agentOfferSdp,
                })
            );
        } catch (error) {
            this.log("human bridge agent offer_sdp rejected", {
                error: error.message,
                sdp: summarizeSdp(agentOfferSdp),
            });

            await this.closeAgentPeer("agent_offer_rejected");
            throw error;
        }

        const transceiver = findAudioTransceiver(this.agentPc);

        if (transceiver && transceiver.sender) {
            await transceiver.sender.replaceTrack(this.agentOutboundTrack);

            try {
                transceiver.direction = "sendrecv";
            } catch (error) {
                this.log("could not force agent transceiver direction", {
                    error: error.message,
                });
            }
        } else {
            this.agentPc.addTrack(this.agentOutboundTrack);
        }

        const answer = await this.agentPc.createAnswer();
        await this.agentPc.setLocalDescription(answer);
        await waitForIceGatheringComplete(this.agentPc, env.webrtcIceGatherTimeoutMs);

        this.status = "agent_connected";
        this.markActivity("agent_answer_ready");
        this.log("human bridge agent answer_sdp ready", {
            agent_id: this.activeAgentId,
            answer_sdp_bytes: this.agentPc.localDescription.sdp.length,
        });

        return {
            answer_sdp: this.agentPc.localDescription.sdp,
            snapshot: this.snapshot(),
        };
    }

    handleAgentTrack(track) {
        if (track.kind !== "audio") {
            return;
        }

        if (this.agentSink) {
            this.agentSink.stop();
        }

        this.agentSink = new RTCAudioSink(track);
        this.agentSink.ondata = (data) => {
            if (this.closedAt) {
                return;
            }

            this.agentFramesReceived += 1;
            this.markActivity("agent_audio");

            if (this.metaAudioSource) {
                this.metaAudioSource.onData(data);
            }
        };

        this.log("human bridge agent audio track attached", {
            agent_id: this.activeAgentId,
            track_id: track.id,
            ready_state: track.readyState,
        });
    }

    async closeAgentPeer(reason = "agent_closed") {
        if (this.agentSink) {
            this.agentSink.stop();
            this.agentSink = null;
        }

        if (this.agentOutboundTrack) {
            this.agentOutboundTrack.stop();
            this.agentOutboundTrack = null;
        }

        if (this.agentPc) {
            this.agentPc.ontrack = null;
            this.agentPc.onconnectionstatechange = null;
            this.agentPc.oniceconnectionstatechange = null;
            this.agentPc.close();
            this.agentPc = null;
        }

        this.agentAudioSource = null;
        this.activeAgentId = null;
        this.markActivity(reason);
    }

    async close(reason = "closed") {
        if (this.closedAt) {
            return;
        }

        this.closedAt = new Date();
        this.status = "closed";

        await this.closeAgentPeer(reason);

        if (this.metaSink) {
            this.metaSink.stop();
            this.metaSink = null;
        }

        if (this.metaOutboundTrack) {
            this.metaOutboundTrack.stop();
            this.metaOutboundTrack = null;
        }

        if (this.metaPc) {
            this.metaPc.ontrack = null;
            this.metaPc.onconnectionstatechange = null;
            this.metaPc.oniceconnectionstatechange = null;
            this.metaPc.close();
            this.metaPc = null;
        }

        this.metaAudioSource = null;
        this.markActivity(reason);
        this.log("human bridge closed", {
            reason,
            meta_frames_received: this.metaFramesReceived,
            agent_frames_received: this.agentFramesReceived,
        });

        if (typeof this.onClosed === "function") {
            this.onClosed(this);
        }
    }

    handlePeerState(peer, state) {
        this.log("human bridge peer state", { peer, state });

        if (["failed", "closed"].includes(state) && peer === "meta" && !this.closedAt) {
            this.close(`${peer}_peer_${state}`).catch((error) => {
                console.error("Error closing human bridge after peer state", error);
            });
        }
    }

    handleIceState(peer, state) {
        this.log("human bridge ice state", { peer, state });

        if (["failed", "closed"].includes(state) && peer === "meta" && !this.closedAt) {
            this.close(`${peer}_ice_${state}`).catch((error) => {
                console.error("Error closing human bridge after ice state", error);
            });
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
            phone_number_id: this.phoneNumberId,
            mode: "human_bridge",
            status: this.status,
            active_agent_id: this.activeAgentId,
            created_at: this.createdAt.toISOString(),
            closed_at: this.closedAt ? this.closedAt.toISOString() : null,
            last_activity_at: new Date(this.lastActivityAt).toISOString(),
            last_activity_type: this.lastActivityType,
            meta_frames_received: this.metaFramesReceived,
            agent_frames_received: this.agentFramesReceived,
            has_meta_peer: Boolean(this.metaPc),
            has_agent_peer: Boolean(this.agentPc),
        };
    }

    log(message, data = {}) {
        console.log(
            `[human-bridge:${this.sessionId} call_id:${this.callId}] ${message}`,
            JSON.stringify(data)
        );
    }
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

module.exports = HumanBridgeCallSession;
