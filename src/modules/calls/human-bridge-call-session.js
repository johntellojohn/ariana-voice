const wrtc = require("@roamhq/wrtc");

const env = require("../../config/env");
const ttsService = require("../tts/tts.service");
const { AudioOutput } = require("./audio-output");
const { CallRecording } = require("./call-recording");

const { RTCAudioSink, RTCAudioSource } = wrtc.nonstandard;
const RTC_AUDIO_FRAME_SAMPLES = 480;
const TONE_SAMPLE_RATE = 48000;

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
        this.callbackUrl = payload.callback_url || null;
        this.recording = new CallRecording({
            sessionId: this.sessionId,
            callId: this.callId,
            tenant: this.tenant,
            agentId: this.agentId,
            callbackUrl: this.callbackUrl,
            baseUrl: this.baseUrl,
            mode: payload.mode || "human_bridge",
            logger: (message, data) => this.log(message, data),
        });
        this.waitMessage = normalizeWaitMessage(payload.wait_message);
        this.waitToneEnabled = payload.wait_tone_enabled !== false;
        this.waitPosition = Number(payload.wait_position || 0) || 0;
        this.createdAt = new Date();
        this.closedAt = null;
        this.status = "created";

        this.metaPc = null;
        this.agentPc = null;
        this.metaAudioSource = null;
        this.metaAudioOutput = null;
        this.agentAudioSource = null;
        this.metaOutboundTrack = null;
        this.agentOutboundTrack = null;
        this.metaSink = null;
        this.agentSink = null;
        this.agentWs = null;
        this.metaFramesReceived = 0;
        this.agentFramesReceived = 0;
        this.metaWsFramesSent = 0;
        this.agentWsFramesReceived = 0;
        this.agentWsSampleRemainder = null;
        this.activeAgentId = null;
        this.waitPlaybackStarted = false;
        this.waitPlaybackPreparing = false;
        this.waitToneTimer = null;
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
        this.metaAudioOutput = new AudioOutput(this.metaAudioSource, {
            sampleRate: TONE_SAMPLE_RATE,
            frameMs: env.callSilenceFrameMs,
            silenceLogEveryFrames: env.callSilenceLogEveryFrames,
            logAudioChunks: env.callAudioDebug,
            logger: (message, data) => this.log(message, data),
            onAudioFrame: (frame, metadata) => this.recording.recordAgentPcm(frame, metadata),
        });
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

        if (this.waitMessage || this.waitToneEnabled) {
            this.metaAudioOutput.start();
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

            if (this.agentAudioSource) {
                this.agentAudioSource.onData(data);
            }

            this.sendMetaAudioToAgentWebSocket(data);
        };

        this.status = "meta_connected";
        this.log("human bridge meta audio track attached", {
            track_id: track.id,
            ready_state: track.readyState,
        });

        this.startWaitingPlayback("meta_track_attached").catch((error) => {
            this.log("human bridge waiting playback failed", {
                reason: "meta_track_attached",
                error: error.message,
            });
        });

        track.onended = () => {
            this.close("meta_track_ended").catch((error) => {
                console.error("Error closing human bridge on meta track end", error);
            });
        };
    }

    async startWaitingPlayback(reason = "waiting_ready") {
        if (
            this.closedAt ||
            this.agentWs ||
            this.agentPc ||
            this.waitPlaybackStarted ||
            this.waitPlaybackPreparing ||
            (!this.waitMessage && !this.waitToneEnabled) ||
            !this.metaAudioOutput
        ) {
            return false;
        }

        this.waitPlaybackPreparing = true;

        try {
            await this.waitForMetaPlaybackReady();

            if (this.closedAt || this.agentWs || this.agentPc) {
                return false;
            }

            this.waitPlaybackStarted = true;
            this.markActivity("waiting_playback_started");
            this.log("human bridge waiting playback started", {
                reason,
                wait_message_configured: Boolean(this.waitMessage),
                wait_tone_enabled: this.waitToneEnabled,
                wait_position: this.waitPosition,
            });

            if (this.waitMessage) {
                try {
                    await this.playWaitMessage(reason);
                } catch (error) {
                    this.log("human bridge wait message playback failed", {
                        reason,
                        error: error.message,
                    });
                }
            }

            if (this.waitToneEnabled && !this.closedAt && !this.agentWs && !this.agentPc) {
                this.startWaitToneLoop();
            }

            return true;
        } finally {
            this.waitPlaybackPreparing = false;
        }
    }

    async playWaitMessage(reason) {
        const ttsResult = await ttsService.synthesize(
            {
                text: this.waitMessage,
                voice: "nova",
                format: "mp3",
                return_audio_base64: true,
                instructions: "Lee este mensaje de espera de forma calmada y natural. No agregues frases nuevas.",
            },
            {
                baseUrl: this.baseUrl,
            }
        );

        let playback;

        if (ttsResult.audio_base64) {
            const audioBuffer = Buffer.from(ttsResult.audio_base64, "base64");

            playback = await this.metaAudioOutput.enqueueAudioBuffer(audioBuffer, {
                source: "human_bridge_wait_message",
                reason,
                format: ttsResult.format || "mp3",
                mime_type: ttsResult.mime_type || "audio/mpeg",
            });
        } else {
            if (!ttsResult.audio_url) {
                throw new Error("Waiting TTS did not return audio_base64 or audio_url");
            }

            playback = await this.metaAudioOutput.enqueueAudioUrl(ttsResult.audio_url, {
                source: "human_bridge_wait_message",
                reason,
            });
        }

        this.markActivity("waiting_message_played");
        this.log("human bridge waiting message playback complete", {
            delivery: ttsResult.audio_base64 ? "base64" : "audio_url",
            audio_url: ttsResult.audio_url || null,
            frames_sent: playback.framesSent,
            frames_queued: playback.framesQueued,
            stopped: playback.stopped,
        });
    }

    startWaitToneLoop() {
        if (this.waitToneTimer || !this.metaAudioOutput) {
            return;
        }

        const enqueueTone = () => {
            if (this.closedAt || this.agentWs || this.agentPc || !this.metaAudioOutput) {
                this.stopWaitingPlayback("agent_or_call_closed");
                return;
            }

            this.metaAudioOutput.enqueuePcm(generateWaitMusicPcm(), {
                source: "human_bridge_wait_music",
            }).catch((error) => {
                this.log("human bridge waiting music failed", {
                    error: error.message,
                });
            });

            this.markActivity("waiting_music_queued");
        };

        enqueueTone();
        this.waitToneTimer = setInterval(enqueueTone, env.humanBridgeWaitToneIntervalMs);
    }

    stopWaitingPlayback(reason = "waiting_stopped") {
        if (this.waitToneTimer) {
            clearInterval(this.waitToneTimer);
            this.waitToneTimer = null;
        }

        if (this.metaAudioOutput) {
            this.metaAudioOutput.stop();
        }
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
        this.stopWaitingPlayback("agent_peer_connected");
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
            this.stopWaitingPlayback("agent_audio");
            this.markActivity("agent_audio");
            this.recording.recordAgentData(data);

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

    attachAgentWebSocket(ws, options = {}) {
        if (this.closedAt) {
            ws.close(1011, "session_closed");
            return;
        }

        if (this.agentWs && this.agentWs.readyState === 1) {
            this.agentWs.close(1000, "agent_replaced");
        }

        this.agentWs = ws;
        this.activeAgentId = options.agentId || options.agent_id || this.activeAgentId;
        this.status = "agent_ws_connected";
        this.stopWaitingPlayback("agent_ws_connected");
        this.markActivity("agent_ws_connected");
        this.log("human bridge agent websocket connected", {
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

            this.agentFramesReceived += 1;
            this.agentWsFramesReceived += 1;
            this.stopWaitingPlayback("agent_ws_audio");
            this.markActivity("agent_ws_audio");

            if (this.agentWsFramesReceived === 1 || this.agentWsFramesReceived % 250 === 0) {
                this.log("human bridge agent websocket audio received", {
                    agent_id: this.activeAgentId,
                    frames: this.agentWsFramesReceived,
                    samples: samples.length,
                });
            }

            this.sendAgentSamplesToMeta(samples);
        });

        ws.on("close", (code, reason) => {
            if (this.agentWs === ws) {
                this.agentWs = null;
            }

            this.markActivity("agent_ws_closed");
            this.log("human bridge agent websocket closed", {
                agent_id: this.activeAgentId,
                code,
                reason: reason ? reason.toString() : "",
            });
        });

        ws.on("error", (error) => {
            this.log("human bridge agent websocket error", {
                agent_id: this.activeAgentId,
                error: error.message,
            });
        });
    }

    sendMetaAudioToAgentWebSocket(data) {
        if (!this.agentWs || this.agentWs.readyState !== 1) {
            return;
        }

        const samples = data && data.samples;

        if (!samples || samples.byteLength === 0) {
            return;
        }

        try {
            const buffer = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
            this.agentWs.send(buffer, { binary: true });
            this.metaWsFramesSent += 1;

            if (this.metaWsFramesSent === 1 || this.metaWsFramesSent % 250 === 0) {
                this.log("human bridge meta audio sent to agent websocket", {
                    agent_id: this.activeAgentId,
                    frames: this.metaWsFramesSent,
                    bytes: buffer.length,
                });
            }
        } catch (error) {
            this.log("human bridge agent websocket send failed", {
                error: error.message,
            });
        }
    }

    sendAgentSamplesToMeta(samples) {
        if (!this.metaAudioSource || !samples || samples.length === 0) {
            return;
        }

        if (this.agentWsSampleRemainder && this.agentWsSampleRemainder.length > 0) {
            const combined = new Int16Array(this.agentWsSampleRemainder.length + samples.length);
            combined.set(this.agentWsSampleRemainder, 0);
            combined.set(samples, this.agentWsSampleRemainder.length);
            samples = combined;
            this.agentWsSampleRemainder = null;
        }

        const completeFramesLength = samples.length - (samples.length % RTC_AUDIO_FRAME_SAMPLES);

        if (completeFramesLength === 0) {
            this.agentWsSampleRemainder = new Int16Array(samples);
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
            this.agentWsSampleRemainder = new Int16Array(samples.subarray(completeFramesLength));
        }

        if (this.agentWsSampleRemainder && (this.agentWsFramesReceived === 1 || this.agentWsFramesReceived % 250 === 0)) {
            this.log("human bridge agent websocket audio trailing samples buffered", {
                agent_id: this.activeAgentId,
                received_samples: samples.length,
                buffered_samples: this.agentWsSampleRemainder.length,
            });
        }
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

        if (this.agentWs && this.agentWs.readyState === 1) {
            this.agentWs.close(1000, reason);
        }

        this.agentWs = null;
        this.agentWsSampleRemainder = null;
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
        this.stopWaitingPlayback(reason);

        await this.closeAgentPeer(reason);

        if (this.metaSink) {
            this.metaSink.stop();
            this.metaSink = null;
        }

        if (this.metaOutboundTrack) {
            this.metaOutboundTrack.stop();
            this.metaOutboundTrack = null;
        }

        if (this.metaAudioOutput) {
            this.metaAudioOutput.stop();
            this.metaAudioOutput = null;
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
            meta_ws_frames_sent: this.metaWsFramesSent,
            agent_ws_frames_received: this.agentWsFramesReceived,
        });

        await this.recording.finalize(reason);

        if (typeof this.onClosed === "function") {
            this.onClosed(this);
        }
    }

    handlePeerState(peer, state) {
        this.log("human bridge peer state", { peer, state });

        if (peer === "meta" && ["connected", "completed"].includes(state)) {
            this.startWaitingPlayback(`meta_peer_${state}`).catch((error) => {
                this.log("human bridge waiting playback failed", {
                    reason: `meta_peer_${state}`,
                    error: error.message,
                });
            });
        }

        if (["failed", "closed"].includes(state) && peer === "meta" && !this.closedAt) {
            this.close(`${peer}_peer_${state}`).catch((error) => {
                console.error("Error closing human bridge after peer state", error);
            });
        }
    }

    handleIceState(peer, state) {
        this.log("human bridge ice state", { peer, state });

        if (peer === "meta" && ["connected", "completed"].includes(state)) {
            this.startWaitingPlayback(`meta_ice_${state}`).catch((error) => {
                this.log("human bridge waiting playback failed", {
                    reason: `meta_ice_${state}`,
                    error: error.message,
                });
            });
        }

        if (["failed", "closed"].includes(state) && peer === "meta" && !this.closedAt) {
            this.close(`${peer}_ice_${state}`).catch((error) => {
                console.error("Error closing human bridge after ice state", error);
            });
        }
    }

    waitForMetaPlaybackReady() {
        if (this.isMetaPlaybackReady()) {
            return Promise.resolve(true);
        }

        this.log("human bridge waiting for meta ICE before wait playback", {
            connection_state: this.metaPc ? this.metaPc.connectionState : null,
            ice_connection_state: this.metaPc ? this.metaPc.iceConnectionState : null,
            timeout_ms: env.callPlaybackWaitForIceMs,
        });

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                cleanup();
                resolve(false);
            }, env.callPlaybackWaitForIceMs);

            const cleanup = () => {
                clearTimeout(timeout);

                if (this.metaPc) {
                    this.metaPc.removeEventListener("connectionstatechange", onStateChange);
                    this.metaPc.removeEventListener("iceconnectionstatechange", onStateChange);
                }
            };

            const onStateChange = () => {
                if (this.isMetaPlaybackReady()) {
                    cleanup();
                    resolve(true);
                }
            };

            if (this.metaPc) {
                this.metaPc.addEventListener("connectionstatechange", onStateChange);
                this.metaPc.addEventListener("iceconnectionstatechange", onStateChange);
            }
        });
    }

    isMetaPlaybackReady() {
        if (!this.metaPc) {
            return false;
        }

        return ["connected", "completed"].includes(this.metaPc.iceConnectionState) ||
            ["connected"].includes(this.metaPc.connectionState);
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
            meta_ws_frames_sent: this.metaWsFramesSent,
            agent_ws_frames_received: this.agentWsFramesReceived,
            wait_message_configured: Boolean(this.waitMessage),
            wait_tone_enabled: this.waitToneEnabled,
            wait_position: this.waitPosition,
            wait_playback_started: this.waitPlaybackStarted,
            has_meta_peer: Boolean(this.metaPc),
            has_agent_peer: Boolean(this.agentPc),
            has_agent_ws: Boolean(this.agentWs),
            callback_url: this.callbackUrl,
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

function normalizeWaitMessage(value) {
    if (typeof value !== "string") {
        return "";
    }

    return value.replace(/\s+/g, " ").trim();
}

function generateWaitMusicPcm() {
    const durationSeconds = 4.2;
    const totalSamples = Math.round(TONE_SAMPLE_RATE * durationSeconds);
    const samples = new Int16Array(totalSamples);
    const amplitude = 0.12 * 0x7fff;
    const fadeSamples = Math.round(TONE_SAMPLE_RATE * 0.12);
    const notes = [
        392.00,
        493.88,
        587.33,
        493.88,
        440.00,
        523.25,
        659.25,
        523.25,
    ];
    const noteDuration = durationSeconds / notes.length;

    for (let index = 0; index < totalSamples; index++) {
        const t = index / TONE_SAMPLE_RATE;
        const noteIndex = Math.min(notes.length - 1, Math.floor(t / noteDuration));
        const noteStart = noteIndex * noteDuration;
        const noteT = Math.max(0, t - noteStart);
        const noteEnvelope = Math.min(1, noteT / 0.08, (noteDuration - noteT) / 0.18);
        const envelope = Math.min(1, index / fadeSamples, (totalSamples - index) / fadeSamples);
        const frequency = notes[noteIndex];
        const tone =
            Math.sin(2 * Math.PI * frequency * t) * 0.62 +
            Math.sin(2 * Math.PI * frequency * 1.5 * t) * 0.18 +
            Math.sin(2 * Math.PI * frequency * 0.5 * t) * 0.20;

        samples[index] = Math.round(tone * amplitude * Math.max(0, envelope) * Math.max(0, noteEnvelope));
    }

    return Buffer.from(samples.buffer);
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
