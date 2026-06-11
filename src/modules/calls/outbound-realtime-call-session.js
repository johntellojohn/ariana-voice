const wrtc = require("@roamhq/wrtc");

const env = require("../../config/env");
const RealtimeCallSession = require("./realtime-call-session");

class OutboundRealtimeCallSession extends RealtimeCallSession {
    async start() {
        this.status = "starting";
        this.pc = new wrtc.RTCPeerConnection({
            iceServers: env.webrtcIceServers,
        });

        this.pc.ontrack = (event) => this.handleTrack(event.track);
        this.pc.onconnectionstatechange = () => this.handleConnectionState();
        this.pc.oniceconnectionstatechange = () => this.handleIceConnectionState();

        this.pc.addTransceiver("audio", { direction: "sendrecv" });

        await this.setupOutboundAudio();
        await this.connectRealtime();

        const offer = await this.pc.createOffer({
            offerToReceiveAudio: true,
        });

        await this.pc.setLocalDescription(offer);
        await waitForIceGatheringComplete(this.pc, env.webrtcIceGatherTimeoutMs);

        this.status = "offer_ready";
        this.log("realtime outbound offer_sdp ready", {
            offer_sdp_bytes: this.pc.localDescription.sdp.length,
            model: this.model(),
            voice: this.voice(),
        });

        return this.pc.localDescription.sdp;
    }

    async applyAnswer(answerSdp) {
        answerSdp = normalizeRemoteSdp(answerSdp);

        if (!answerSdp.startsWith("v=0")) {
            const error = new Error("answer_sdp must be a valid SDP answer");
            error.status = 422;
            throw error;
        }

        if (!this.pc || this.closedAt) {
            const error = new Error("Outbound call session is not active");
            error.status = 409;
            throw error;
        }

        if (this.pc.remoteDescription || this.pc.currentRemoteDescription) {
            return this.snapshot();
        }

        try {
            await this.pc.setRemoteDescription(
                new wrtc.RTCSessionDescription({
                    type: "answer",
                    sdp: answerSdp,
                })
            );
        } catch (error) {
            this.log("realtime outbound answer_sdp rejected", {
                error: error.message,
                sdp: summarizeSdp(answerSdp),
            });

            throw error;
        }

        this.status = "answer_applied";
        this.markActivity("remote_answer_applied");
        this.log("realtime outbound answer_sdp applied", {
            answer_sdp_bytes: answerSdp.length,
        });

        this.playInitialGreeting("outbound_answer_applied").catch((error) => {
            this.log("realtime outbound initial greeting failed", {
                reason: "outbound_answer_applied",
                error: error.message,
            });
        });

        return this.snapshot();
    }

    async playInitialGreeting(reason = "playback_ready") {
        return super.playInitialGreeting(reason);
    }

    handleRealtimeEvent(event) {
        super.handleRealtimeEvent(event);

        if (!event || this.closedAt || this.notificationCloseScheduled) {
            return;
        }

        if (
            this.notificationOnly &&
            this.hangupAfterInitialGreeting &&
            this.initialGreetingPlayed &&
            ["response.output_audio.done", "response.done"].includes(event.type)
        ) {
            this.notificationCloseScheduled = true;
            setTimeout(() => {
                this.close("notification_initial_greeting_completed").catch((error) => {
                    this.log("could not close notification outbound session", {
                        error: error.message,
                    });
                });
            }, 800);
        }
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
    return String(sdp || "")
        .replace(/\\r\\n/g, "\r\n")
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\r\n|\r|\n/g, "\r\n")
        .trim();
}

function summarizeSdp(sdp) {
    const lines = String(sdp || "").split(/\r\n|\r|\n/);
    const invalidLines = lines
        .map((line, index) => ({ line: index + 1, text: line.slice(0, 120) }))
        .filter((entry) => entry.text !== "" && !/^[a-z]=/.test(entry.text))
        .slice(0, 5);

    return {
        bytes: Buffer.byteLength(String(sdp || "")),
        lines: lines.length,
        first_line: lines[0] ? lines[0].slice(0, 80) : "",
        invalid_lines: invalidLines,
    };
}

module.exports = OutboundRealtimeCallSession;
