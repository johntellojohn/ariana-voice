const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const wrtc = require("@roamhq/wrtc");

const env = require("../../config/env");
const sttService = require("../stt/stt.service");
const ttsService = require("../tts/tts.service");
const CallVad = require("./call-vad");
const { AudioOutput } = require("./audio-output");
const { createWavBuffer } = require("./wav.util");

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
        this.language = payload.language || env.callAudioLanguage;
        this.createdAt = new Date();
        this.closedAt = null;
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

        this.audioSource = new RTCAudioSource();
        this.audioOutput = new AudioOutput(this.audioSource, {
            frameMs: env.callSilenceFrameMs,
            logger: (message, data) => this.log(message, data),
        });

        const outboundTrack = this.audioSource.createTrack();
        this.outboundTrack = outboundTrack;
        this.pc.addTrack(outboundTrack);
        this.log("local audio track added before answer", {
            track_id: outboundTrack.id,
            kind: outboundTrack.kind,
            ready_state: outboundTrack.readyState,
        });
        this.audioOutput.start();

        this.pc.ontrack = (event) => this.handleTrack(event.track);
        this.pc.onconnectionstatechange = () => this.handleConnectionState();
        this.pc.oniceconnectionstatechange = () => this.handleIceConnectionState();

        await this.pc.setRemoteDescription(
            new wrtc.RTCSessionDescription({
                type: "offer",
                sdp: this.offerSdp,
            })
        );

        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        await waitForIceGatheringComplete(this.pc, env.webrtcIceGatherTimeoutMs);

        this.status = "answer_ready";
        this.log("answer_sdp ready", {
            answer_sdp_bytes: this.pc.localDescription.sdp.length,
            connection_state: this.pc.connectionState,
            ice_connection_state: this.pc.iceConnectionState,
            ice_gathering_state: this.pc.iceGatheringState,
        });

        return this.pc.localDescription.sdp;
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
        this.log("remote audio track attached", {
            track_id: track.id,
            ready_state: track.readyState,
        });

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

        const turn = this.vad.push(data);

        if (turn) {
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
        const transcription = await sttService.transcribe({
            file: {
                path: inbound.filePath,
                originalname: inbound.filename,
                mimetype: "audio/wav",
                size: inbound.size,
            },
            body: {
                language: this.language,
            },
            cleanup: false,
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
        const reply = callbackResponse && callbackResponse.data
            ? callbackResponse.data
            : callbackResponse || {};

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
                voice: reply.voice,
                format: reply.format || "mp3",
                instructions: reply.instructions,
            },
            {
                baseUrl: this.baseUrl,
            }
        );
        await this.playAudioUrl(ttsResult.audio_url, "gateway_tts");
    }

    async playAudioUrl(audioUrl, source) {
        this.log("agent audio_url received", {
            audio_url: audioUrl,
            source,
            connection_state: this.pc ? this.pc.connectionState : null,
            ice_connection_state: this.pc ? this.pc.iceConnectionState : null,
        });

        const playback = await this.audioOutput.enqueueAudioUrl(audioUrl, {
            source,
        });

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

    async close(reason = "closed") {
        if (this.closedAt) {
            return;
        }

        this.closedAt = new Date();
        this.status = "closed";

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
            created_at: this.createdAt.toISOString(),
            closed_at: this.closedAt ? this.closedAt.toISOString() : null,
            callback_url: this.callbackUrl,
        };
    }

    log(message, data = {}) {
        console.log(
            `[call:${this.sessionId || "pending"} call_id:${this.callId || "unknown"}] ${message}`,
            JSON.stringify(data)
        );
    }
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

module.exports = CallSession;
