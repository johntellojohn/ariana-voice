const wrtc = require("@roamhq/wrtc");
const WebSocket = require("ws");

const env = require("../../config/env");
const { callTool } = require("../laravel/voice-agent-tools.service");
const { AudioOutput } = require("./audio-output");
const { int16ArrayToBuffer } = require("./wav.util");

const { RTCAudioSink, RTCAudioSource } = wrtc.nonstandard;
const REALTIME_SAMPLE_RATE = 24000;
const META_SAMPLE_RATE = 48000;

class RealtimeCallSession {
    constructor(payload, options = {}) {
        this.sessionId = options.sessionId;
        this.baseUrl = options.baseUrl;
        this.onClosed = options.onClosed || null;
        this.callId = payload.call_id;
        this.phoneNumberId = payload.phone_number_id;
        this.offerSdp = payload.offer_sdp;
        this.tenant = payload.tenant || null;
        this.agentId = payload.agent_id || null;
        this.toolsBaseUrl = payload.tools_base_url || null;
        this.initialGreeting = normalizeInitialGreeting(payload.initial_greeting);
        this.realtime = payload.realtime || {};
        this.createdAt = new Date();
        this.closedAt = null;
        this.status = "created";
        this.pc = null;
        this.audioSource = null;
        this.audioOutput = null;
        this.outboundTrack = null;
        this.sinks = [];
        this.remoteTracks = [];
        this.realtimeSocket = null;
        this.realtimeReady = false;
        this.audioInputReady = false;
        this.outputActive = false;
        this.currentResponseId = null;
        this.currentAssistantItemId = null;
        this.responseGeneration = 0;
        this.toolGeneration = 0;
        this.lastActivityAt = Date.now();
        this.lastActivityType = "created";
        this.lastSpeechAt = null;
        this.lastPlaybackAt = null;
        this.sequence = 0;
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

        await this.setupOutboundAudio();
        await this.connectRealtime();

        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        await waitForIceGatheringComplete(this.pc, env.webrtcIceGatherTimeoutMs);

        this.status = "answer_ready";
        this.log("realtime answer_sdp ready", {
            answer_sdp_bytes: this.pc.localDescription.sdp.length,
            model: this.model(),
            voice: this.voice(),
        });

        return this.pc.localDescription.sdp;
    }

    async setupOutboundAudio() {
        this.audioSource = new RTCAudioSource();
        this.audioOutput = new AudioOutput(this.audioSource, {
            sampleRate: META_SAMPLE_RATE,
            frameMs: env.callSilenceFrameMs,
            silenceLogEveryFrames: env.callSilenceLogEveryFrames,
            logger: (message, data) => this.log(message, data),
        });

        const outboundTrack = this.audioSource.createTrack();
        this.outboundTrack = outboundTrack;
        const audioTransceiver = this.findAudioTransceiver();

        if (audioTransceiver && audioTransceiver.sender) {
            await audioTransceiver.sender.replaceTrack(outboundTrack);

            try {
                audioTransceiver.direction = "sendrecv";
            } catch (error) {
                this.log("could not force realtime audio transceiver direction", {
                    error: error.message,
                });
            }
        } else {
            this.pc.addTrack(outboundTrack);
        }

        this.audioOutput.start();
    }

    async connectRealtime() {
        if (!env.openaiApiKey) {
            const error = new Error("OPENAI_API_KEY is not configured");
            error.status = 503;
            throw error;
        }

        const url = new URL("wss://api.openai.com/v1/realtime");
        url.searchParams.set("model", this.model());

        this.realtimeSocket = new WebSocket(url, {
            headers: {
                Authorization: `Bearer ${env.openaiApiKey}`,
            },
        });

        this.realtimeSocket.on("message", (message) => {
            let event = null;

            try {
                event = JSON.parse(message.toString());
            } catch (error) {
                this.log("could not parse realtime websocket event", {
                    error: error.message,
                });
                return;
            }

            this.handleRealtimeEvent(event);
        });
        this.realtimeSocket.on("error", (error) => {
            this.log("realtime websocket error", {
                error: error.message,
            });
        });
        this.realtimeSocket.on("close", (code, reasonBuffer) => {
            const reason = reasonBuffer ? reasonBuffer.toString() : "";
            this.realtimeReady = false;
            this.log("realtime websocket closed", {
                code,
                reason,
            });

            if (!this.closedAt && this.status !== "starting") {
                this.close(`realtime_socket_closed_${code}`).catch((error) => {
                    console.error("Error closing realtime socket session", error);
                });
            }
        });

        await waitForOpenSocket(this.realtimeSocket, env.realtimeConnectTimeoutMs);
        const sessionUpdateAck = waitForRealtimeSessionUpdated(
            this.realtimeSocket,
            env.realtimeConnectTimeoutMs
        );

        this.sendRealtimeEvent({
            type: "session.update",
            session: this.sessionConfig(),
        });
        await sessionUpdateAck;
        this.realtimeReady = true;

        if (this.initialGreeting) {
            this.sendRealtimeEvent({
                type: "conversation.item.create",
                item: {
                    type: "message",
                    role: "user",
                    content: [
                        {
                            type: "input_text",
                            text: "La llamada acaba de conectar. Saluda brevemente con el saludo configurado y pregunta como puedes ayudar.",
                        },
                    ],
                },
            });
            this.sendRealtimeEvent({
                type: "response.create",
                response: {
                    output_modalities: ["audio"],
                    instructions: `Usa este saludo inicial si encaja de forma natural: ${this.initialGreeting}`,
                },
            });
        }
    }

    sessionConfig() {
        return {
            type: "realtime",
            model: this.model(),
            instructions: this.instructions(),
            output_modalities: ["audio"],
            audio: {
                input: {
                    format: {
                        type: "audio/pcm",
                        rate: REALTIME_SAMPLE_RATE,
                    },
                    transcription: {
                        model: env.realtimeTranscriptionModel,
                        language: this.language(),
                    },
                    turn_detection: this.turnDetection(),
                },
                output: {
                    format: {
                        type: "audio/pcm",
                        rate: REALTIME_SAMPLE_RATE,
                    },
                    voice: this.voice(),
                },
            },
            tools: this.tools(),
            tool_choice: "auto",
            parallel_tool_calls: false,
        };
    }

    tools() {
        return [
            functionTool("get_agent_context", "Obtiene contexto vigente de agente, llamada y configuracion.", {
                type: "object",
                properties: {},
                additionalProperties: false,
            }),
            functionTool("search_knowledge", "Busca en la base de conocimiento vectorial del agente.", {
                type: "object",
                properties: {
                    query: { type: "string" },
                    limit: { type: "integer" },
                },
                required: ["query"],
                additionalProperties: false,
            }),
            functionTool("search_customer", "Consulta el cliente asociado a la llamada.", {
                type: "object",
                properties: {},
                additionalProperties: false,
            }),
            functionTool("check_availability", "Consulta disponibilidad real de agenda.", {
                type: "object",
                properties: {
                    fecha: { type: "string" },
                    dia_semana: { type: "string" },
                    hora: { type: "string" },
                    cantidad_dias: { type: "integer" },
                    trabajador_id: { type: "integer" },
                    trabajador_nombre: { type: "string" },
                    caracteristica: { type: "string" },
                    duracion_minutos: { type: "integer" },
                    momento: { type: "string" },
                },
                additionalProperties: false,
            }),
            functionTool("create_appointment", "Crea una cita solo si el cliente confirmo explicitamente.", {
                type: "object",
                properties: {
                    fecha_hora: { type: "string" },
                    opcion_id: { type: "string" },
                    trabajador_id: { type: "integer" },
                    trabajador_nombre: { type: "string" },
                    caracteristica: { type: "string" },
                    duracion_minutos: { type: "integer" },
                    descripcion: { type: "string" },
                    confirmado_por_cliente: { type: "boolean" },
                },
                required: ["fecha_hora", "confirmado_por_cliente"],
                additionalProperties: false,
            }),
            functionTool("save_call_event", "Guarda transcript o evento relevante de la llamada.", {
                type: "object",
                properties: {
                    role: { type: "string" },
                    text: { type: "string" },
                    event: { type: "string" },
                },
                additionalProperties: false,
            }),
        ];
    }

    turnDetection() {
        const configured = this.realtime.turn_detection || {};

        return {
            type: configured.type || "server_vad",
            threshold: numberOr(configured.threshold, 0.5),
            prefix_padding_ms: numberOr(configured.prefix_padding_ms, 300),
            silence_duration_ms: numberOr(configured.silence_duration_ms, 500),
            create_response: configured.create_response !== false,
            interrupt_response: configured.interrupt_response !== false,
        };
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
        this.log("realtime remote audio track attached", {
            track_id: track.id,
            ready_state: track.readyState,
        });

        track.onended = () => {
            this.close("remote_track_ended").catch((error) => {
                console.error("Error closing ended realtime call session", error);
            });
        };
    }

    handleAudioData(data) {
        if (this.closedAt || !this.realtimeReady) {
            return;
        }

        const pcm48 = int16ArrayToBuffer(data.samples);
        const pcm24 = resamplePcm16(pcm48, data.sampleRate || META_SAMPLE_RATE, REALTIME_SAMPLE_RATE);

        if (!pcm24.length) {
            return;
        }

        this.sendRealtimeEvent({
            type: "input_audio_buffer.append",
            audio: pcm24.toString("base64"),
        });
        this.markActivity("remote_audio_streamed");
    }

    handleRealtimeEvent(event) {
        if (!event || this.closedAt) {
            return;
        }

        switch (event.type) {
            case "session.updated":
                this.audioInputReady = true;
                this.log("realtime session updated", {
                    model: this.model(),
                    voice: this.voice(),
                });
                break;
            case "response.created":
                this.currentResponseId = event.response && event.response.id;
                this.responseGeneration += 1;
                this.outputActive = true;
                break;
            case "response.output_audio.delta":
                this.playRealtimeAudio(event);
                break;
            case "response.output_audio.done":
            case "response.done":
                this.outputActive = false;
                this.lastPlaybackAt = Date.now();
                this.markActivity("realtime_response_done");
                break;
            case "response.function_call_arguments.done":
                this.handleFunctionCall(event).catch((error) => {
                    this.log("realtime tool handling failed", {
                        call_id: event.call_id,
                        name: event.name,
                        error: error.message,
                    });
                });
                break;
            case "conversation.item.input_audio_transcription.completed":
                this.saveTranscript("user", event.transcript, event).catch(() => {});
                break;
            case "response.audio_transcript.done":
            case "response.output_audio_transcript.done":
                this.saveTranscript("assistant", event.transcript, event).catch(() => {});
                break;
            case "input_audio_buffer.speech_started":
                this.lastSpeechAt = Date.now();
                this.handleInterruption("user_speech_started");
                break;
            case "error":
                this.log("realtime event error", {
                    error: event.error || event,
                });
                break;
            default:
                break;
        }
    }

    playRealtimeAudio(event) {
        const delta = event.delta || "";

        if (!delta || !this.audioOutput) {
            return;
        }

        this.currentAssistantItemId = event.item_id || this.currentAssistantItemId;
        const pcm24 = Buffer.from(delta, "base64");
        const pcm48 = resamplePcm16(pcm24, REALTIME_SAMPLE_RATE, META_SAMPLE_RATE);

        this.audioOutput.enqueuePcm(pcm48, {
            source: "openai_realtime",
            response_id: event.response_id,
            item_id: event.item_id,
        }).catch((error) => {
            this.log("realtime audio playback failed", {
                error: error.message,
            });
        });
        this.markActivity("realtime_audio_received");
    }

    async handleFunctionCall(event) {
        const generation = this.toolGeneration;
        const args = parseJsonObject(event.arguments);
        const result = await callTool(
            event.name,
            {
                tools_base_url: this.toolsBaseUrl,
                call_id: this.callId,
                session_id: this.sessionId,
                tenant: this.tenant,
                agent_id: this.agentId,
                tool_call_id: event.call_id,
            },
            args
        ).catch((error) => ({
            ok: false,
            message: error.message,
            status: error.response && error.response.status,
            data: error.response && error.response.data,
        }));

        if (generation !== this.toolGeneration || this.closedAt) {
            this.log("realtime tool result ignored after interruption", {
                name: event.name,
                call_id: event.call_id,
            });
            return;
        }

        this.sendRealtimeEvent({
            type: "conversation.item.create",
            item: {
                type: "function_call_output",
                call_id: event.call_id,
                output: JSON.stringify(result),
            },
        });
        this.sendRealtimeEvent({
            type: "response.create",
            response: {
                output_modalities: ["audio"],
            },
        });
    }

    handleInterruption(reason = "interrupted") {
        this.toolGeneration += 1;
        this.outputActive = false;

        if (this.audioOutput) {
            this.audioOutput.clear(reason);
        }

        this.sendRealtimeEvent({
            type: "response.cancel",
        });

        if (this.currentAssistantItemId) {
            this.sendRealtimeEvent({
                type: "conversation.item.truncate",
                item_id: this.currentAssistantItemId,
                content_index: 0,
                audio_end_ms: 0,
            });
        }

        this.markActivity("interruption");
        this.log("realtime response interrupted", {
            reason,
            response_id: this.currentResponseId,
            assistant_item_id: this.currentAssistantItemId,
        });
    }

    async saveTranscript(role, text, event) {
        text = String(text || "").trim();

        if (!text || !this.toolsBaseUrl) {
            return;
        }

        await callTool(
            "save_call_event",
            {
                tools_base_url: this.toolsBaseUrl,
                call_id: this.callId,
                session_id: this.sessionId,
                tenant: this.tenant,
                agent_id: this.agentId,
                tool_call_id: event.event_id,
            },
            {
                role,
                text,
                event: event.type,
            }
        );
    }

    sendRealtimeEvent(event) {
        if (!this.realtimeSocket || this.realtimeSocket.readyState !== WebSocket.OPEN) {
            return;
        }

        try {
            this.realtimeSocket.send(JSON.stringify(event));
        } catch (error) {
            this.log("could not send realtime event", {
                type: event.type,
                error: error.message,
            });
        }
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

    async close(reason = "closed") {
        if (this.closedAt) {
            return;
        }

        this.closedAt = new Date();
        this.status = "closed";
        this.closeReason = reason;

        for (const sink of this.sinks) {
            sink.stop();
        }

        this.sinks = [];

        if (this.audioOutput) {
            this.audioOutput.stop();
        }

        if (this.realtimeSocket && this.realtimeSocket.readyState !== WebSocket.CLOSED) {
            this.realtimeSocket.close(1000, reason);
        }

        if (this.pc) {
            this.pc.close();
        }

        await this.saveTranscript("system", `call closed: ${reason}`, {
            event_id: `closed-${this.sessionId}`,
            type: "call.closed",
        }).catch(() => {});

        if (this.onClosed) {
            this.onClosed(this);
        }
    }

    handleConnectionState() {
        const state = this.pc.connectionState;

        this.log("realtime peer connection state changed", {
            connection_state: state,
            ice_connection_state: this.pc.iceConnectionState,
        });

        if (["failed", "disconnected", "closed"].includes(state)) {
            this.close(`peer_connection_${state}`).catch((error) => {
                console.error("Error closing realtime peer connection", error);
            });
        }
    }

    handleIceConnectionState() {
        const state = this.pc.iceConnectionState;

        this.log("realtime ice connection state changed", {
            connection_state: this.pc.connectionState,
            ice_connection_state: state,
        });

        if (["failed", "disconnected", "closed"].includes(state)) {
            this.close(`ice_${state}`).catch((error) => {
                console.error("Error closing realtime ICE connection", error);
            });
        }
    }

    snapshot() {
        return {
            session_id: this.sessionId,
            call_id: this.callId,
            phone_number_id: this.phoneNumberId,
            tenant: this.tenant,
            agent_id: this.agentId,
            status: this.status,
            realtime: true,
            realtime_ready: this.realtimeReady,
            output_active: this.outputActive,
            sequence: this.sequence,
            last_activity_at: new Date(this.lastActivityAt).toISOString(),
            last_activity_type: this.lastActivityType,
            last_speech_at: this.lastSpeechAt
                ? new Date(this.lastSpeechAt).toISOString()
                : null,
            last_playback_at: this.lastPlaybackAt
                ? new Date(this.lastPlaybackAt).toISOString()
                : null,
            created_at: this.createdAt.toISOString(),
            closed_at: this.closedAt ? this.closedAt.toISOString() : null,
            tools_base_url: this.toolsBaseUrl,
        };
    }

    model() {
        return this.realtime.model || env.openaiRealtimeModel;
    }

    voice() {
        return this.realtime.voice || env.openaiRealtimeVoice;
    }

    language() {
        return this.realtime.language || env.callAudioLanguage || "es";
    }

    instructions() {
        return this.realtime.instructions || "Eres un agente de voz de EVA. Responde en espanol con frases breves y naturales.";
    }

    markActivity(type) {
        this.lastActivityAt = Date.now();
        this.lastActivityType = type;
    }

    log(message, data = {}) {
        console.log(
            `[realtime-call:${this.sessionId || "pending"} call_id:${this.callId || "unknown"}] ${message}`,
            JSON.stringify(data)
        );
    }
}

function functionTool(name, description, parameters) {
    return {
        type: "function",
        name,
        description,
        parameters,
    };
}

function waitForOpenSocket(socket, timeoutMs) {
    if (socket.readyState === WebSocket.OPEN) {
        return Promise.resolve(true);
    }

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error("Timed out waiting for OpenAI Realtime WebSocket"));
        }, timeoutMs);

        function cleanup() {
            clearTimeout(timeout);
            socket.off("open", onOpen);
            socket.off("error", onError);
            socket.off("close", onClose);
        }

        function onOpen() {
            cleanup();
            resolve(true);
        }

        function onError(error) {
            cleanup();
            reject(new Error(error.message || "OpenAI Realtime WebSocket error"));
        }

        function onClose(code, reasonBuffer) {
            cleanup();
            const reason = reasonBuffer ? reasonBuffer.toString() : "";
            reject(
                new Error(
                    `OpenAI Realtime WebSocket closed before opening (${code}${reason ? `: ${reason}` : ""})`
                )
            );
        }

        socket.once("open", onOpen);
        socket.once("error", onError);
        socket.once("close", onClose);
    });
}

function waitForRealtimeSessionUpdated(socket, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error("Timed out waiting for OpenAI Realtime session.updated"));
        }, timeoutMs);

        function cleanup() {
            clearTimeout(timeout);
            socket.off("message", onMessage);
            socket.off("error", onError);
            socket.off("close", onClose);
        }

        function onMessage(message) {
            let event = null;

            try {
                event = JSON.parse(message.toString());
            } catch (error) {
                return;
            }

            if (event.type === "session.updated") {
                cleanup();
                resolve(event);
                return;
            }

            if (event.type === "error") {
                cleanup();
                reject(new Error(realtimeErrorMessage(event)));
            }
        }

        function onError(error) {
            cleanup();
            reject(new Error(error.message || "OpenAI Realtime WebSocket error"));
        }

        function onClose(code, reasonBuffer) {
            cleanup();
            const reason = reasonBuffer ? reasonBuffer.toString() : "";
            reject(
                new Error(
                    `OpenAI Realtime WebSocket closed before session.updated (${code}${reason ? `: ${reason}` : ""})`
                )
            );
        }

        socket.on("message", onMessage);
        socket.once("error", onError);
        socket.once("close", onClose);
    });
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

function resamplePcm16(buffer, fromRate, toRate) {
    if (!buffer || !buffer.length || fromRate === toRate) {
        return buffer || Buffer.alloc(0);
    }

    const inputSamples = Math.floor(buffer.length / 2);
    const outputSamples = Math.max(1, Math.round((inputSamples * toRate) / fromRate));
    const output = Buffer.alloc(outputSamples * 2);

    for (let index = 0; index < outputSamples; index += 1) {
        const sourceIndex = Math.min(
            inputSamples - 1,
            Math.floor((index * fromRate) / toRate)
        );
        output.writeInt16LE(buffer.readInt16LE(sourceIndex * 2), index * 2);
    }

    return output;
}

function parseJsonObject(value) {
    if (value && typeof value === "object") {
        return value;
    }

    try {
        const parsed = JSON.parse(String(value || "{}"));
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch (error) {
        return {};
    }
}

function realtimeErrorMessage(event) {
    const error = event && event.error ? event.error : {};
    const pieces = [
        error.message || "OpenAI Realtime error",
        error.code ? `code=${error.code}` : null,
        error.param ? `param=${error.param}` : null,
        error.type ? `type=${error.type}` : null,
        error.event_id ? `event_id=${error.event_id}` : null,
    ].filter(Boolean);

    return pieces.join(" ");
}

function numberOr(value, fallback) {
    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeInitialGreeting(value) {
    if (typeof value !== "string") {
        return "";
    }

    return value.replace(/\s+/g, " ").trim();
}

module.exports = RealtimeCallSession;
module.exports._private = {
    resamplePcm16,
    parseJsonObject,
    realtimeErrorMessage,
};
