const wrtc = require("@roamhq/wrtc");

const env = require("../../config/env");
const { CallRecording } = require("./call-recording");

const { RTCAudioSink, RTCAudioSource } = wrtc.nonstandard;
const RTC_AUDIO_FRAME_SAMPLES = 480;
const SILENCE_FRAME_SAMPLES_20MS = 960;
const SILENCE_INTERVAL_MS = 20;
const RECONNECT_GRACE_PERIOD_MS = 15000;

class MobileBridgeCallSession {
    constructor(payload, options = {}) {
        this.sessionId = options.sessionId;
        this.baseUrl = options.baseUrl;
        this.onClosed = options.onClosed || null;
        this.callId = payload.call_id;
        this.phoneNumberId = payload.phone_number_id;
        this.offerSdp = payload.offer_sdp;
        this.tenant = payload.tenant || null;
        this.agentId = payload.agent_id || null;
        this.callbackUrl = payload.callback_url || null;
        this.recording = new CallRecording({
            sessionId: this.sessionId,
            callId: this.callId,
            tenant: this.tenant,
            agentId: this.agentId,
            callbackUrl: this.callbackUrl,
            baseUrl: this.baseUrl,
            mode: payload.mode || "mobile_bridge",
            logger: (message, data) => this.log(message, data),
        });
        this.createdAt = new Date();
        this.closedAt = null;
        this.status = "created";

        this.metaPc = null;
        this.metaAudioSource = null;
        this.metaOutboundTrack = null;
        this.metaSink = null;
        this.mobileWs = null;

        this.metaFramesReceived = 0;
        this.mobileFramesReceived = 0;
        this.metaWsFramesSent = 0;
        this.mobileWsFramesReceived = 0;
        this.mobileWsSampleRemainder = null;
        this.activeAgentId = null;

        this.keepAliveSilenceTimer = null;
        this.reconnectGraceTimer = null;
        this.silenceFrame = new Int16Array(SILENCE_FRAME_SAMPLES_20MS);
        this.keepAliveSilenceFramesSent = 0;

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
        this.log("mobile bridge meta answer_sdp ready", {
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
            this.recording.recordCustomerData(data);

            this.sendMetaAudioToMobileWebSocket(data);
        };

        this.status = "meta_connected";
        this.log("mobile bridge meta audio track attached", {
            track_id: track.id,
            ready_state: track.readyState,
        });

        track.onended = () => {
            this.close("meta_track_ended").catch((error) => {
                console.error("Error closing mobile bridge on meta track end", error);
            });
        };
    }

    attachMobileWebSocket(ws, options = {}) {
        if (this.closedAt) {
            ws.close(1011, "session_closed");
            return;
        }

        // Cancel any pending reconnection grace period and silence keep-alive
        this.stopReconnectGracePeriod();
        this.stopKeepAliveSilence();

        if (this.mobileWs && this.mobileWs.readyState === 1) {
            this.mobileWs.close(1000, "mobile_replaced");
        }

        this.mobileWs = ws;
        this.activeAgentId = options.agentId || options.agent_id || this.agentId;
        this.status = "mobile_ws_connected";
        this.markActivity("mobile_ws_connected");
        this.log("mobile bridge websocket connected", {
            agent_id: this.activeAgentId,
        });

        ws.on("message", (message, isBinary) => {
            if (!isBinary || this.closedAt || !this.metaAudioSource) {
                return;
            }

            const buffer = Buffer.isBuffer(message) ? message : Buffer.from(message);

            if (buffer.length < 2) {
                return;
            }

            const samples = new Int16Array(
                buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
            );

            if (samples.length === 0) {
                return;
            }

            this.mobileFramesReceived += 1;
            this.mobileWsFramesReceived += 1;
            this.markActivity("mobile_ws_audio");

            if (this.mobileWsFramesReceived === 1 || this.mobileWsFramesReceived % 250 === 0) {
                this.log("mobile bridge websocket audio received", {
                    agent_id: this.activeAgentId,
                    frames: this.mobileWsFramesReceived,
                    samples: samples.length,
                });
            }

            this.sendMobileSamplesToMeta(samples);
        });

        ws.on("close", (code, reason) => {
            const wasActive = this.mobileWs === ws;
            if (wasActive) {
                this.mobileWs = null;
            }

            this.markActivity("mobile_ws_closed");
            this.log("mobile bridge websocket closed", {
                agent_id: this.activeAgentId,
                code,
                reason: reason ? reason.toString() : "",
                was_active: wasActive,
            });

            if (wasActive && !this.closedAt) {
                this.startKeepAliveSilence();
                this.startReconnectGracePeriod();
            }
        });

        ws.on("error", (error) => {
            this.log("mobile bridge websocket error", {
                agent_id: this.activeAgentId,
                error: error.message,
            });
        });
    }

    startKeepAliveSilence() {
        if (this.keepAliveSilenceTimer || this.closedAt) {
            return;
        }

        this.status = "waiting_mobile_reconnect";
        this.keepAliveSilenceFramesSent = 0;
        this.log("starting keep-alive silence for mobile disconnection", {
            interval_ms: SILENCE_INTERVAL_MS,
            samples_per_frame: SILENCE_FRAME_SAMPLES_20MS,
        });

        this.keepAliveSilenceTimer = setInterval(() => {
            if (this.closedAt || !this.metaAudioSource) {
                this.stopKeepAliveSilence();
                return;
            }

            try {
                this.metaAudioSource.onData({
                    samples: this.silenceFrame,
                    sampleRate: 48000,
                    bitsPerSample: 16,
                    channelCount: 1,
                    numberOfFrames: SILENCE_FRAME_SAMPLES_20MS,
                });

                this.keepAliveSilenceFramesSent += 1;

                if (this.keepAliveSilenceFramesSent === 1 || this.keepAliveSilenceFramesSent % 250 === 0) {
                    this.log("keep-alive silence sent to Meta", {
                        frames_sent: this.keepAliveSilenceFramesSent,
                    });
                }
            } catch (error) {
                this.log("keep-alive silence error sending to Meta", {
                    error: error.message,
                });
            }
        }, SILENCE_INTERVAL_MS);
    }

    stopKeepAliveSilence() {
        if (this.keepAliveSilenceTimer) {
            clearInterval(this.keepAliveSilenceTimer);
            this.keepAliveSilenceTimer = null;
            this.log("stopped keep-alive silence", {
                total_frames_sent: this.keepAliveSilenceFramesSent,
            });
        }
    }

    startReconnectGracePeriod() {
        this.stopReconnectGracePeriod();

        this.log("started mobile reconnection grace period", {
            grace_period_ms: RECONNECT_GRACE_PERIOD_MS,
        });

        this.reconnectGraceTimer = setTimeout(() => {
            this.reconnectGraceTimer = null;
            if (!this.mobileWs && !this.closedAt) {
                this.log("mobile reconnection grace period expired; closing call session", {
                    grace_period_ms: RECONNECT_GRACE_PERIOD_MS,
                });
                this.close("mobile_reconnect_timeout").catch((error) => {
                    console.error("Error closing mobile bridge session after reconnect timeout", error);
                });
            }
        }, RECONNECT_GRACE_PERIOD_MS);
    }

    stopReconnectGracePeriod() {
        if (this.reconnectGraceTimer) {
            clearTimeout(this.reconnectGraceTimer);
            this.reconnectGraceTimer = null;
            this.log("stopped mobile reconnection grace period");
        }
    }

    sendMetaAudioToMobileWebSocket(data) {
        if (!this.mobileWs || this.mobileWs.readyState !== 1) {
            return;
        }

        const samples = data && data.samples;

        if (!samples || samples.byteLength === 0) {
            return;
        }

        try {
            const buffer = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
            this.mobileWs.send(buffer, { binary: true });
            this.metaWsFramesSent += 1;

            if (this.metaWsFramesSent === 1 || this.metaWsFramesSent % 250 === 0) {
                this.log("mobile bridge meta audio sent to mobile websocket", {
                    agent_id: this.activeAgentId,
                    frames: this.metaWsFramesSent,
                    bytes: buffer.length,
                });
            }
        } catch (error) {
            this.log("mobile bridge websocket send failed", {
                error: error.message,
            });
        }
    }

    sendMobileSamplesToMeta(samples) {
        if (!this.metaAudioSource || !samples || samples.length === 0) {
            return;
        }

        if (this.mobileWsSampleRemainder && this.mobileWsSampleRemainder.length > 0) {
            const combined = new Int16Array(this.mobileWsSampleRemainder.length + samples.length);
            combined.set(this.mobileWsSampleRemainder, 0);
            combined.set(samples, this.mobileWsSampleRemainder.length);
            samples = combined;
            this.mobileWsSampleRemainder = null;
        }

        const completeFramesLength = samples.length - (samples.length % RTC_AUDIO_FRAME_SAMPLES);

        if (completeFramesLength === 0) {
            this.mobileWsSampleRemainder = new Int16Array(samples);
            return;
        }

        for (let offset = 0; offset < completeFramesLength; offset += RTC_AUDIO_FRAME_SAMPLES) {
            const frameSamples = new Int16Array(samples.subarray(offset, offset + RTC_AUDIO_FRAME_SAMPLES));

            this.recording.recordAgentSamples(frameSamples, {
                sampleRate: 48000,
                channelCount: 1,
            });

            this.metaAudioSource.onData({
                samples: frameSamples,
                sampleRate: 48000,
                bitsPerSample: 16,
                channelCount: 1,
                numberOfFrames: RTC_AUDIO_FRAME_SAMPLES,
            });
        }

        if (completeFramesLength !== samples.length) {
            this.mobileWsSampleRemainder = new Int16Array(samples.subarray(completeFramesLength));
        }

        if (this.mobileWsSampleRemainder && (this.mobileWsFramesReceived === 1 || this.mobileWsFramesReceived % 250 === 0)) {
            this.log("mobile bridge websocket audio trailing samples buffered", {
                agent_id: this.activeAgentId,
                received_samples: samples.length,
                buffered_samples: this.mobileWsSampleRemainder.length,
            });
        }
    }

    handlePeerState(peer, state) {
        this.log("mobile bridge peer state", { peer, state });

        if (["failed", "closed"].includes(state) && peer === "meta" && !this.closedAt) {
            this.close(`${peer}_peer_${state}`).catch((error) => {
                console.error("Error closing mobile bridge after peer state", error);
            });
        }
    }

    handleIceState(peer, state) {
        this.log("mobile bridge ice state", { peer, state });

        if (["failed", "closed"].includes(state) && peer === "meta" && !this.closedAt) {
            this.close(`${peer}_ice_${state}`).catch((error) => {
                console.error("Error closing mobile bridge after ice state", error);
            });
        }
    }

    async close(reason = "closed") {
        if (this.closedAt) {
            return;
        }

        this.closedAt = new Date();
        this.status = "closed";

        this.stopReconnectGracePeriod();
        this.stopKeepAliveSilence();

        if (this.mobileWs && this.mobileWs.readyState === 1) {
            this.mobileWs.close(1000, reason);
        }

        this.mobileWs = null;
        this.mobileWsSampleRemainder = null;

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
        this.log("mobile bridge closed", {
            reason,
            meta_frames_received: this.metaFramesReceived,
            mobile_frames_received: this.mobileFramesReceived,
            meta_ws_frames_sent: this.metaWsFramesSent,
            mobile_ws_frames_received: this.mobileWsFramesReceived,
        });

        await this.recording.finalize(reason);

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
            phone_number_id: this.phoneNumberId,
            tenant: this.tenant,
            agent_id: this.agentId,
            mode: "mobile_bridge",
            status: this.status,
            created_at: this.createdAt ? this.createdAt.toISOString() : null,
            closed_at: this.closedAt ? this.closedAt.toISOString() : null,
            last_activity_at: new Date(this.lastActivityAt).toISOString(),
            last_activity_type: this.lastActivityType,
            meta_frames_received: this.metaFramesReceived,
            mobile_frames_received: this.mobileFramesReceived,
            meta_ws_frames_sent: this.metaWsFramesSent,
            mobile_ws_frames_received: this.mobileWsFramesReceived,
            has_meta_peer: Boolean(this.metaPc),
            has_mobile_ws: Boolean(this.mobileWs),
            keep_alive_silence_active: Boolean(this.keepAliveSilenceTimer),
            reconnect_grace_active: Boolean(this.reconnectGraceTimer),
            callback_url: this.callbackUrl,
        };
    }

    log(message, data = {}) {
        console.log(
            `[mobile-bridge:${this.sessionId} call_id:${this.callId}] ${message}`,
            JSON.stringify(data)
        );
    }
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

module.exports = MobileBridgeCallSession;
