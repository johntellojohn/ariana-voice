const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const wrtc = require("@roamhq/wrtc");

const env = require("../../config/env");
const sttService = require("../stt/stt.service");
const ttsService = require("../tts/tts.service");
const CallVad = require("./call-vad");
const { AudioOutput } = require("./audio-output");
const { CallRecording } = require("./call-recording");
const { createWavBuffer } = require("./wav.util");
const { normalizeTtsConfig, toTtsVoice } = require("./voice-profile");

const { RTCAudioSink, RTCAudioSource } = wrtc.nonstandard;

class CallSession {
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
            mode: payload.mode || "legacy",
            logger: (message, data) => this.log(message, data),
        });
        this.initialGreeting = normalizeInitialGreeting(payload.initial_greeting);
        this.initialGreetingPending = Boolean(this.initialGreeting);
        this.initialGreetingPlaybackStarted = false;
        this.initialGreetingPlayed = false;
        this.tts = normalizeTtsConfig(payload.tts);
        this.language = resolveCallLanguage(payload.language);
        this.createdAt = new Date();
        this.closedAt = null;
        this.lastActivityAt = Date.now();
        this.lastActivityType = "created";
        this.lastSpeechAt = null;
        this.lastPlaybackAt = null;
        this.lifecycleTimer = null;
        this.outputActive = false;
        this.inputMutedUntil = 0;
        this.lastInputMutedLogAt = 0;
        this.sequence = 0;
        this.status = "created";
        this.turnQueue = [];
        this.processingTurn = false;
        this.sinks = [];
        this.remoteTracks = [];
        this.pc = null;
        this.audioSource = null;
        this.audioOutput = null;
        this.outboundTrack = null;
        this.vad = new CallVad({
            threshold: env.callTurnRmsThreshold,
            silenceMs: env.callTurnSilenceMs,
            minSpeechMs: env.callTurnMinSpeechMs,
            maxTurnMs: env.callTurnMaxMs,
        });
    }

    async start() {
        this.status = "starting";
        this.pc = new wrtc.RTCPeerConnection({
            iceServers: env.webrtcIceServers,
        });

        this.pc.ontrack = (event) => this.handleTrack(event.track);
        this.pc.onconnectionstatechange = () => this.handleConnectionState();
        this.pc.oniceconnectionstatechange = () => this.handleIceConnectionState();

        await this.pc.setRemoteDescription(
            new wrtc.RTCSessionDescription({
                type: "offer",
                sdp: this.offerSdp,
            })
        );
        this.log("remote offer audio sdp", {
            audio_sections: extractAudioSdpSummary(this.offerSdp),
        });

        await this.setupOutboundAudio();

        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        await waitForIceGatheringComplete(this.pc, env.webrtcIceGatherTimeoutMs);

        this.status = "answer_ready";
        const answerSdpSummary = extractAudioSdpSummary(this.pc.localDescription.sdp);
        this.log("answer_sdp ready", {
            answer_sdp_bytes: this.pc.localDescription.sdp.length,
            audio_sections: answerSdpSummary,
            senders: this.getSenderSnapshot(),
            connection_state: this.pc.connectionState,
            ice_connection_state: this.pc.iceConnectionState,
            ice_gathering_state: this.pc.iceGatheringState,
        });

        if (env.callLogSdp) {
            this.log("answer_sdp full", {
                sdp: this.pc.localDescription.sdp,
            });
        }

        return this.pc.localDescription.sdp;
    }

    async setupOutboundAudio() {
        this.audioSource = new RTCAudioSource();
        this.audioOutput = new AudioOutput(this.audioSource, {
            frameMs: env.callSilenceFrameMs,
            silenceLogEveryFrames: env.callSilenceLogEveryFrames,
            logAudioChunks: env.callAudioDebug,
            logger: (message, data) => this.log(message, data),
            onAudioFrame: (frame, metadata) => this.recording.recordAgentPcm(frame, metadata),
        });

        const outboundTrack = this.audioSource.createTrack();
        this.outboundTrack = outboundTrack;

        const audioTransceiver = this.findAudioTransceiver();

        if (audioTransceiver && audioTransceiver.sender) {
            await audioTransceiver.sender.replaceTrack(outboundTrack);

            try {
                audioTransceiver.direction = "sendrecv";
            } catch (error) {
                this.log("could not force audio transceiver direction", {
                    error: error.message,
                });
            }

            this.log("local audio track attached to offered transceiver before answer", {
                track_id: outboundTrack.id,
                kind: outboundTrack.kind,
                ready_state: outboundTrack.readyState,
                transceiver_mid: audioTransceiver.mid,
                transceiver_direction: audioTransceiver.direction,
                sender_track: describeTrack(audioTransceiver.sender.track),
            });
        } else {
            this.pc.addTrack(outboundTrack);
            this.log("local audio track added before answer", {
                track_id: outboundTrack.id,
                kind: outboundTrack.kind,
                ready_state: outboundTrack.readyState,
            });
        }

        this.log("audio senders after local track setup", {
            senders: this.getSenderSnapshot(),
            transceivers: this.getTransceiverSnapshot(),
        });
        this.audioOutput.start();
        this.startLifecycleWatch();
    }

    findAudioTransceiver() {
        return this.pc
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

    handleTrack(track) {
        this.remoteTracks.push(track);

        if (track.kind !== "audio") {
            return;
        }

        const sink = new RTCAudioSink(track);
        sink.ondata = (data) => this.handleAudioData(data);
        this.sinks.push(sink);
        this.status = "connected";
        this.markActivity("remote_track_attached");
        this.log("remote audio track attached", {
            track_id: track.id,
            ready_state: track.readyState,
        });
        this.playInitialGreeting("remote_track_attached");

        track.onended = () => {
            this.close("remote_track_ended").catch((error) => {
                console.error("Error closing ended call session", error);
            });
        };
    }

    handleAudioData(data) {
        if (this.closedAt) {
            return;
        }

        this.recording.recordCustomerData(data);

        if (this.shouldIgnoreInboundAudio()) {
            this.vad.reset();
            this.logInputMuted();
            return;
        }

        const turn = this.vad.push(data);

        if (this.vad.lastHasSpeech) {
            this.markActivity("remote_speech");
            this.lastSpeechAt = this.lastActivityAt;
        }

        if (turn) {
            this.markActivity("turn_detected");
            this.turnQueue.push(turn);
            this.processTurnQueue().catch((error) => {
                console.error("Error processing call turn", error);
            });
        }
    }

    async processTurnQueue() {
        if (this.processingTurn) {
            return;
        }

        this.processingTurn = true;

        try {
            while (this.turnQueue.length && !this.closedAt) {
                const turn = this.turnQueue.shift();
                await this.processTurn(turn);
            }
        } finally {
            this.processingTurn = false;
        }
    }

    async processTurn(turn) {
        const sequence = this.sequence + 1;
        this.sequence = sequence;

        const inbound = await this.persistInboundTurn(turn, sequence);
        const sttBody = {
            language: this.language,
            temperature: env.callSttTemperature,
            prompt: env.callSttPrompt,
        };

        this.log("call turn transcribing", {
            sequence,
            language: sttBody.language,
            duration_ms: turn.durationMs,
            audio_bytes: inbound.size,
            prompt_enabled: Boolean(sttBody.prompt),
            temperature: sttBody.temperature,
        });

        const transcription = await sttService.transcribe({
            file: {
                path: inbound.filePath,
                originalname: inbound.filename,
                mimetype: "audio/wav",
                size: inbound.size,
            },
            body: sttBody,
            cleanup: false,
        });

        this.log("call turn transcribed", {
            sequence,
            language: sttBody.language,
            model: transcription.model,
            text: transcription.text,
            duration_ms: turn.durationMs,
        });

        if (!transcription.text) {
            return;
        }

        const callbackResponse = await this.sendCallback({
            event: "transcript",
            session_id: this.sessionId,
            call_id: this.callId,
            sequence,
            text: transcription.text,
            audio_url: inbound.audioUrl,
            tenant: this.tenant,
            agent_id: this.agentId,
        });

        await this.handleAgentResponse(callbackResponse);
    }

    async persistInboundTurn(turn, sequence) {
        fs.mkdirSync(env.ttsOutputDir, { recursive: true });

        const filename = `inbound-${this.sessionId}-${sequence}.wav`;
        const filePath = path.join(env.ttsOutputDir, filename);
        const wav = createWavBuffer(turn.pcm, {
            sampleRate: turn.sampleRate,
            channelCount: turn.channelCount,
        });

        await fsp.writeFile(filePath, wav);

        return {
            filename,
            filePath,
            size: wav.length,
            audioUrl: this.buildAudioUrl(filename),
        };
    }

    async handleAgentResponse(callbackResponse) {
        this.log("agent callback response received", {
            response: callbackResponse,
        });

        const reply = extractAgentReply(callbackResponse);

        if (reply.audio_url) {
            await this.playAudioUrl(reply.audio_url, "laravel_audio_url");
            return;
        }

        if (!reply.text) {
            return;
        }

        const ttsResult = await ttsService.synthesize(
            {
                text: reply.text,
                model: reply.model || this.tts.model,
                voice: reply.voice ? toTtsVoice(reply.voice) : this.tts.voice,
                format: reply.format || this.tts.format || "mp3",
                speed: reply.speed || this.tts.speed,
                instructions: reply.instructions || this.tts.instructions,
            },
            {
                baseUrl: this.baseUrl,
            }
        );
        await this.playAudioUrl(ttsResult.audio_url, "gateway_tts");
    }

    async playInitialGreeting(reason = "playback_ready") {
        if (
            !this.initialGreeting ||
            this.initialGreetingPlaybackStarted ||
            this.initialGreetingPlayed ||
            this.closedAt
        ) {
            return false;
        }

        if (!this.audioOutput || !this.pc) {
            this.log("initial greeting deferred until playback is ready", {
                reason,
                has_audio_output: Boolean(this.audioOutput),
                has_peer_connection: Boolean(this.pc),
            });

            return false;
        }

        this.initialGreetingPlaybackStarted = true;
        this.initialGreetingPending = true;

        try {
            this.log("initial greeting TTS requested", {
                reason,
                text_length: this.initialGreeting.length,
            });

            const ttsResult = await ttsService.synthesize(
                {
                    text: this.initialGreeting,
                    model: this.tts.model,
                    voice: this.tts.voice,
                    format: this.tts.format || "mp3",
                    speed: this.tts.speed,
                    instructions: this.tts.instructions,
                },
                {
                    baseUrl: this.baseUrl,
                }
            );

            if (!ttsResult.audio_url) {
                throw new Error("Initial greeting TTS did not return audio_url");
            }

            await this.playAudioUrl(ttsResult.audio_url, "initial_greeting");
            this.initialGreetingPlayed = true;

            return true;
        } catch (error) {
            this.log("initial greeting playback failed", {
                reason,
                error: error.message,
            });

            return false;
        } finally {
            this.initialGreetingPending = false;
        }
    }

    async playAudioUrl(audioUrl, source) {
        this.markActivity("agent_audio_received");
        this.log("agent audio_url received", {
            audio_url: audioUrl,
            source,
            senders: this.getSenderSnapshot(),
            connection_state: this.pc ? this.pc.connectionState : null,
            ice_connection_state: this.pc ? this.pc.iceConnectionState : null,
        });

        await this.waitForPlaybackReady();

        this.outputActive = true;

        let playback;

        try {
            playback = await this.audioOutput.enqueueAudioUrl(audioUrl, {
                source,
            });
        } finally {
            this.outputActive = false;
            this.inputMutedUntil = Date.now() + env.callPostPlaybackMuteMs;
            this.markActivity("agent_audio_played");
            this.lastPlaybackAt = this.lastActivityAt;
        }

        this.log("agent audio_url playback complete", {
            audio_url: audioUrl,
            source,
            frames_sent: playback.framesSent,
            frames_queued: playback.framesQueued,
            pcm_bytes: playback.pcmBytes,
            bytes_downloaded: playback.bytesDownloaded,
            stopped: playback.stopped,
            connection_state: this.pc ? this.pc.connectionState : null,
            ice_connection_state: this.pc ? this.pc.iceConnectionState : null,
        });
    }

    async sendCallback(payload) {
        if (!this.callbackUrl) {
            return null;
        }

        const axios = require("axios");
        const response = await axios.post(this.callbackUrl, payload, {
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                Authorization: env.voiceApiToken
                    ? `Bearer ${env.voiceApiToken}`
                    : undefined,
            },
            timeout: env.callCallbackTimeoutMs,
        });

        return response.data;
    }

    waitForPlaybackReady() {
        if (this.isIceReady()) {
            return Promise.resolve(true);
        }

        this.log("waiting for ICE before playback", {
            connection_state: this.pc ? this.pc.connectionState : null,
            ice_connection_state: this.pc ? this.pc.iceConnectionState : null,
            timeout_ms: env.callPlaybackWaitForIceMs,
        });

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                cleanup();
                this.log("playback continuing without connected ICE", {
                    connection_state: this.pc ? this.pc.connectionState : null,
                    ice_connection_state: this.pc ? this.pc.iceConnectionState : null,
                });
                resolve(false);
            }, env.callPlaybackWaitForIceMs);

            const cleanup = () => {
                clearTimeout(timeout);

                if (this.pc) {
                    this.pc.removeEventListener("connectionstatechange", onStateChange);
                    this.pc.removeEventListener("iceconnectionstatechange", onStateChange);
                }
            };

            const onStateChange = () => {
                if (this.isIceReady()) {
                    cleanup();
                    this.log("ICE ready for playback", {
                        connection_state: this.pc ? this.pc.connectionState : null,
                        ice_connection_state: this.pc ? this.pc.iceConnectionState : null,
                    });
                    resolve(true);
                }
            };

            this.pc.addEventListener("connectionstatechange", onStateChange);
            this.pc.addEventListener("iceconnectionstatechange", onStateChange);
        });
    }

    isIceReady() {
        if (!this.pc) {
            return false;
        }

        return (
            this.pc.connectionState === "connected" ||
            ["connected", "completed"].includes(this.pc.iceConnectionState)
        );
    }

    async close(reason = "closed") {
        if (this.closedAt) {
            return;
        }

        this.closedAt = new Date();
        this.status = "closed";
        this.stopLifecycleWatch();

        const finalTurn = this.vad.flush();

        if (finalTurn) {
            this.turnQueue.push(finalTurn);
            await this.processTurnQueue();
        }

        for (const sink of this.sinks) {
            sink.stop();
        }

        this.sinks = [];

        if (this.audioOutput) {
            this.audioOutput.stop();
        }

        if (this.pc) {
            this.pc.close();
        }

        await this.recording.finalize(reason);

        await this.sendCallback({
            event: "ended",
            session_id: this.sessionId,
            call_id: this.callId,
            reason,
            tenant: this.tenant,
            agent_id: this.agentId,
        }).catch((error) => {
            console.error("Error sending ended callback", error.message);
        });

        if (this.onClosed) {
            this.onClosed(this);
        }
    }

    handleConnectionState() {
        const state = this.pc.connectionState;

        this.log("peer connection state changed", {
            connection_state: state,
            ice_connection_state: this.pc.iceConnectionState,
        });

        if (["failed", "disconnected", "closed"].includes(state)) {
            this.close(`peer_connection_${state}`).catch((error) => {
                console.error("Error closing peer connection", error);
            });

            return;
        }

        if (state === "connected") {
            this.playInitialGreeting("peer_connection_connected");
        }
    }

    handleIceConnectionState() {
        const state = this.pc.iceConnectionState;

        this.log("ice connection state changed", {
            connection_state: this.pc.connectionState,
            ice_connection_state: state,
        });

        if (["failed", "disconnected", "closed"].includes(state)) {
            this.close(`ice_${state}`).catch((error) => {
                console.error("Error closing ICE connection", error);
            });

            return;
        }

        if (["connected", "completed"].includes(state)) {
            this.playInitialGreeting("ice_connected");
        }
    }

    buildAudioUrl(filename) {
        const relativeUrl = `/api/audio/${filename}`;

        if (!this.baseUrl) {
            return relativeUrl;
        }

        return `${this.baseUrl.replace(/\/$/, "")}${relativeUrl}`;
    }

    snapshot() {
        return {
            session_id: this.sessionId,
            call_id: this.callId,
            phone_number_id: this.phoneNumberId,
            tenant: this.tenant,
            agent_id: this.agentId,
            status: this.status,
            sequence: this.sequence,
            language: this.language,
            last_activity_at: new Date(this.lastActivityAt).toISOString(),
            last_activity_type: this.lastActivityType,
            last_speech_at: this.lastSpeechAt
                ? new Date(this.lastSpeechAt).toISOString()
                : null,
            last_playback_at: this.lastPlaybackAt
                ? new Date(this.lastPlaybackAt).toISOString()
                : null,
            output_active: this.outputActive,
            initial_greeting_configured: Boolean(this.initialGreeting),
            initial_greeting_pending: this.initialGreetingPending,
            initial_greeting_played: this.initialGreetingPlayed,
            input_muted_until: this.inputMutedUntil
                ? new Date(this.inputMutedUntil).toISOString()
                : null,
            created_at: this.createdAt.toISOString(),
            closed_at: this.closedAt ? this.closedAt.toISOString() : null,
            callback_url: this.callbackUrl,
        };
    }

    getSenderSnapshot() {
        if (!this.pc) {
            return [];
        }

        return this.pc.getSenders().map((sender, index) => ({
            index,
            track: describeTrack(sender.track),
        }));
    }

    getTransceiverSnapshot() {
        if (!this.pc) {
            return [];
        }

        return this.pc.getTransceivers().map((transceiver, index) => ({
            index,
            mid: transceiver.mid,
            direction: transceiver.direction,
            current_direction: transceiver.currentDirection,
            sender_track: describeTrack(transceiver.sender && transceiver.sender.track),
            receiver_track: describeTrack(transceiver.receiver && transceiver.receiver.track),
        }));
    }

    log(message, data = {}) {
        console.log(
            `[call:${this.sessionId || "pending"} call_id:${this.callId || "unknown"}] ${message}`,
            JSON.stringify(data)
        );
    }

    startLifecycleWatch() {
        if (this.lifecycleTimer) {
            return;
        }

        this.lifecycleTimer = setInterval(() => {
            this.checkLifecycle();
        }, 5000);

        if (this.lifecycleTimer.unref) {
            this.lifecycleTimer.unref();
        }

        this.log("call lifecycle watch started", {
            idle_timeout_ms: env.callIdleTimeoutMs,
            max_duration_ms: env.callMaxDurationMs,
        });
    }

    stopLifecycleWatch() {
        if (!this.lifecycleTimer) {
            return;
        }

        clearInterval(this.lifecycleTimer);
        this.lifecycleTimer = null;
    }

    markActivity(type) {
        this.lastActivityAt = Date.now();
        this.lastActivityType = type;
    }

    checkLifecycle() {
        if (this.closedAt) {
            return;
        }

        const now = Date.now();
        const ageMs = now - this.createdAt.getTime();
        const idleMs = now - this.lastActivityAt;
        const hasPendingAudio = this.audioOutput && this.audioOutput.hasPendingAudio();
        const isBusy = this.processingTurn || hasPendingAudio || this.outputActive;

        if (env.callMaxDurationMs > 0 && ageMs >= env.callMaxDurationMs) {
            this.log("call max duration reached", {
                age_ms: ageMs,
                max_duration_ms: env.callMaxDurationMs,
                connection_state: this.pc ? this.pc.connectionState : null,
                ice_connection_state: this.pc ? this.pc.iceConnectionState : null,
            });
            this.close("call_max_duration").catch((error) => {
                console.error("Error closing max duration call", error);
            });
            return;
        }

        if (env.callIdleTimeoutMs > 0 && !isBusy && idleMs >= env.callIdleTimeoutMs) {
            this.log("call idle timeout reached", {
                idle_ms: idleMs,
                idle_timeout_ms: env.callIdleTimeoutMs,
                last_activity_type: this.lastActivityType,
                connection_state: this.pc ? this.pc.connectionState : null,
                ice_connection_state: this.pc ? this.pc.iceConnectionState : null,
            });
            this.close("call_idle_timeout").catch((error) => {
                console.error("Error closing idle call", error);
            });
        }
    }

    shouldIgnoreInboundAudio() {
        return this.initialGreetingPending || this.outputActive || Date.now() < this.inputMutedUntil;
    }

    logInputMuted() {
        const now = Date.now();

        if (now - this.lastInputMutedLogAt < 5000) {
            return;
        }

        this.lastInputMutedLogAt = now;
        this.log("inbound audio ignored during agent playback", {
            output_active: this.outputActive,
            input_muted_until: this.inputMutedUntil
                ? new Date(this.inputMutedUntil).toISOString()
                : null,
        });
    }
}

function resolveCallLanguage(payloadLanguage) {
    if (env.callAllowLanguageOverride && payloadLanguage) {
        return payloadLanguage;
    }

    return env.callAudioLanguage || payloadLanguage || "es";
}

function normalizeInitialGreeting(value) {
    if (typeof value !== "string") {
        return "";
    }

    return value.replace(/\s+/g, " ").trim();
}

function waitForIceGatheringComplete(pc, timeoutMs) {
    if (pc.iceGatheringState === "complete") {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        const timeout = setTimeout(done, timeoutMs);

        function done() {
            clearTimeout(timeout);
            pc.removeEventListener("icegatheringstatechange", onStateChange);
            resolve();
        }

        function onStateChange() {
            if (pc.iceGatheringState === "complete") {
                done();
            }
        }

        pc.addEventListener("icegatheringstatechange", onStateChange);
    });
}

function extractAgentReply(response) {
    const candidates = [
        response && response.data,
        response && response.data && response.data.data,
        response,
    ];

    return (
        candidates.find((candidate) => {
            return (
                candidate &&
                typeof candidate === "object" &&
                (candidate.audio_url || candidate.text)
            );
        }) || {}
    );
}

function describeTrack(track) {
    if (!track) {
        return null;
    }

    return {
        id: track.id,
        kind: track.kind,
        enabled: track.enabled,
        ready_state: track.readyState,
    };
}

function extractAudioSdpSummary(sdp) {
    return getSdpMediaSections(sdp)
        .filter((section) => section.startsWith("m=audio"))
        .map((section) => ({
            direction: getSdpDirection(section),
            mid: getSdpAttribute(section, "mid"),
            setup: getSdpAttribute(section, "setup"),
            codecs: getSdpCodecs(section),
            raw: section,
        }));
}

function getSdpMediaSections(sdp) {
    const normalized = String(sdp || "").replace(/\r\n/g, "\n");
    const parts = normalized.split("\nm=");

    return parts
        .slice(1)
        .map((part) => `m=${part.trim()}`);
}

function getSdpDirection(section) {
    const match = section.match(/^a=(sendrecv|sendonly|recvonly|inactive)$/m);

    return match ? match[1] : "not_set";
}

function getSdpAttribute(section, attribute) {
    const match = section.match(new RegExp(`^a=${attribute}:(.+)$`, "m"));

    return match ? match[1].trim() : null;
}

function getSdpCodecs(section) {
    const codecs = [];
    const rtpmapMatches = section.matchAll(/^a=rtpmap:(\d+)\s+(.+)$/gm);

    for (const match of rtpmapMatches) {
        codecs.push({
            payload_type: match[1],
            codec: match[2],
        });
    }

    return codecs;
}

module.exports = CallSession;
