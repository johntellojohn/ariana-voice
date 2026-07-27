const wrtc = require("@roamhq/wrtc");

const env = require("../../config/env");
const HumanBridgeCallSession = require("./human-bridge-call-session");

class OutboundHumanBridgeCallSession extends HumanBridgeCallSession {
    async start() {
        this.status = "starting";
        this.metaPc = new wrtc.RTCPeerConnection({
            iceServers: env.webrtcIceServers,
        });

        this.metaPc.ontrack = (event) => this.handleMetaTrack(event.track);
        this.metaPc.onconnectionstatechange = () => this.handlePeerState("meta", this.metaPc.connectionState);
        this.metaPc.oniceconnectionstatechange = () => this.handleIceState("meta", this.metaPc.iceConnectionState);

        this.metaPc.addTransceiver("audio", { direction: "sendrecv" });

        await this.setupMetaOutboundAudio();

        const offer = await this.metaPc.createOffer({
            offerToReceiveAudio: true,
        });

        await this.metaPc.setLocalDescription(offer);
        await waitForIceGatheringComplete(this.metaPc, env.webrtcIceGatherTimeoutMs);

        this.status = "offer_ready";
        this.markActivity("meta_offer_ready");
        this.log("human bridge outbound offer_sdp ready", {
            offer_sdp_bytes: this.metaPc.localDescription.sdp.length,
        });

        return this.metaPc.localDescription.sdp;
    }

    async applyAnswer(answerSdp) {
        answerSdp = normalizeRemoteSdp(answerSdp);

        if (!answerSdp.startsWith("v=0")) {
            const error = new Error("answer_sdp must be a valid SDP answer");
            error.status = 422;
            throw error;
        }

        if (!this.metaPc || this.closedAt) {
            const error = new Error("Outbound human bridge session is not active");
            error.status = 409;
            throw error;
        }

        if (this.metaPc.remoteDescription || this.metaPc.currentRemoteDescription) {
            return this.snapshot();
        }

        try {
            await this.metaPc.setRemoteDescription(
                new wrtc.RTCSessionDescription({
                    type: "answer",
                    sdp: answerSdp,
                })
            );
        } catch (error) {
            this.log("human bridge outbound answer_sdp rejected", {
                error: error.message,
                sdp: summarizeSdp(answerSdp),
            });

            throw error;
        }

        this.status = "answer_applied";
        this.markActivity("remote_answer_applied");
        this.log("human bridge outbound answer_sdp applied", {
            answer_sdp_bytes: answerSdp.length,
        });

        return this.snapshot();
    }
}

function waitForIceGatheringComplete(pc, timeoutMs) {
    if (pc.iceGatheringState === "complete") {
        return Promise.resolve(true);
    }

    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            pc.removeEventListener("icegatheringstatechange", handleChange);
            resolve(false);
        }, timeoutMs);

        function handleChange() {
            if (pc.iceGatheringState !== "complete") {
                return;
            }

            clearTimeout(timeout);
            pc.removeEventListener("icegatheringstatechange", handleChange);
            resolve(true);
        }

        pc.addEventListener("icegatheringstatechange", handleChange);
    });
}

function normalizeRemoteSdp(sdp) {
    const normalized = String(sdp || "")
        .replace(/\\r\\n/g, "\r\n")
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\r\n|\r|\n/g, "\r\n")
        .trimStart()
        .replace(/(?:\r\n)+$/g, "");

    return normalized === "" ? "" : `${normalized}\r\n`;
}

function summarizeSdp(sdp) {
    const lines = String(sdp || "").split(/\r\n|\r|\n/);

    return {
        bytes: Buffer.byteLength(String(sdp || "")),
        lines: lines.length,
        first_line: lines[0] ? lines[0].slice(0, 80) : "",
    };
}

module.exports = OutboundHumanBridgeCallSession;
