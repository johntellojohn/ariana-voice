const wrtc = require("@roamhq/wrtc");
const WebSocket = require("ws");
const axios = require("axios");

const env = require("../../config/env");
const { callTool } = require("../laravel/voice-agent-tools.service");
const ttsService = require("../tts/tts.service");
const { AudioOutput } = require("./audio-output");
const { SpeechInterruptionGate } = require("./speech-interruption-gate");
const { int16ArrayToBuffer } = require("./wav.util");

const { RTCAudioSink, RTCAudioSource } = wrtc.nonstandard;
const REALTIME_SAMPLE_RATE = 24000;
const META_SAMPLE_RATE = 48000;
const RTC_AUDIO_FRAME_SAMPLES = 480;

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
        this.callbackUrl = payload.callback_url || null;
        this.toolsBaseUrl = payload.tools_base_url || null;
        this.notificationOnly = Boolean(payload.notification_only);
        this.hangupAfterInitialGreeting = Boolean(payload.hangup_after_initial_greeting);
        this.initialGreeting = normalizeInitialGreeting(payload.initial_greeting);
        this.initialGreetingPlaybackStarted = false;
        this.initialGreetingPlaybackPreparing = false;
        this.initialGreetingPending = Boolean(this.initialGreeting);
        this.initialGreetingPlayed = false;
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
        this.remoteAudioFramesReceived = 0;
        this.realtimeSocket = null;
        this.realtimeReady = false;
        this.realtimeClosedForHumanTransfer = false;
        this.humanTransferActive = false;
        this.pendingHumanTransferRealtimeClose = false;
        this.agentWs = null;
        this.activeAgentId = null;
        this.metaWsFramesSent = 0;
        this.agentWsFramesReceived = 0;
        this.agentWsSampleRemainder = null;
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
        this.inputSpeechFrames = [];
        this.lastInputLevel = 0;
        this.interruptionGate = new SpeechInterruptionGate({
            debounceMs: this.interruptionDebounceMs(),
            onInterrupt: (reason) => this.handleInterruption(reason),
            onIgnored: (reason) => this.log("realtime speech start ignored", { reason }),
            shouldInterrupt: () => this.hasConfirmedInputSpeech(),
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
            logAudioChunks: env.callAudioDebug,
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

            if (!this.closedAt && this.status !== "starting" && !this.realtimeClosedForHumanTransfer) {
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

    }

    sessionConfig() {
        const tools = this.notificationOnly ? [] : this.tools();

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
            tools,
            tool_choice: this.notificationOnly ? "none" : "auto",
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
            functionTool(
                "search_knowledge",
                "Busca fragmentos reales en la base de conocimiento vectorial del agente. Usala para preguntas informativas sobre documentos, TXT cargados, miembros del equipo, roles, politicas o informacion interna, aunque mencione capacitaciones, soporte, horarios o agenda.",
                {
                    type: "object",
                    properties: {
                        query: { type: "string" },
                        limit: { type: "integer" },
                    },
                    required: ["query"],
                    additionalProperties: false,
                }
            ),
            functionTool("search_customer", "Consulta el cliente asociado a la llamada.", {
                type: "object",
                properties: {},
                additionalProperties: false,
            }),
            functionTool("check_availability", "Consulta disponibilidad real de agenda solo cuando el usuario quiera agendar, reagendar o ver horarios disponibles. No la uses para preguntas informativas sobre miembros del equipo, roles o areas de apoyo.", {
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
            functionTool("list_appointments", "Lista las citas existentes del cliente asociado a la llamada. Usala cuando pregunte si tiene citas, turnos, reservas o agendamientos.", {
                type: "object",
                properties: {
                    solo_futuras: { type: "boolean" },
                },
                additionalProperties: false,
            }),
            functionTool("show_appointments", "Muestra los agendamientos existentes del cliente asociado a la llamada. Usala cuando pida ver, mostrar o consultar sus agendamientos.", {
                type: "object",
                properties: {
                    solo_futuras: { type: "boolean" },
                },
                additionalProperties: false,
            }),
            functionTool("reschedule_appointment", "Reagenda una cita existente del cliente. Usala despues de consultar disponibilidad y solo si el cliente confirmo la nueva opcion.", {
                type: "object",
                properties: {
                    appointment_id: { type: "integer" },
                    fecha_hora: { type: "string" },
                    opcion_id: { type: "string" },
                    trabajador_id: { type: "integer" },
                    trabajador_nombre: { type: "string" },
                    caracteristica: { type: "string" },
                    confirmado_por_cliente: { type: "boolean" },
                },
                required: ["fecha_hora", "confirmado_por_cliente"],
                additionalProperties: false,
            }),
            functionTool("cancel_appointment", "Cancela una cita futura del cliente solo si el cliente confirmo explicitamente la cancelacion.", {
                type: "object",
                properties: {
                    appointment_id: { type: "integer" },
                    motivo: { type: "string" },
                    confirmado_por_cliente: { type: "boolean" },
                },
                required: ["confirmado_por_cliente"],
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
            functionTool("transfer_to_human", "Transfiere esta llamada a un agente humano disponible cuando el cliente pida hablar con una persona, soporte, asesor o recepcion, o cuando la IA no entienda o detecte molestia.", {
                type: "object",
                properties: {
                    trigger: {
                        type: "string",
                        enum: ["customer_request", "ai_confusion", "customer_frustrated", "unresolved"],
                    },
                    reason: { type: "string" },
                    preferred_agent_id: { type: "integer" },
                },
                required: ["trigger"],
                additionalProperties: false,
            }),
        ];
    }

    turnDetection() {
        const configured = this.realtime.turn_detection || {};

        if (this.notificationOnly) {
            return {
                type: configured.type || "server_vad",
                threshold: numberOr(configured.threshold, env.realtimeVadThreshold),
                prefix_padding_ms: numberOr(configured.prefix_padding_ms, 300),
                silence_duration_ms: numberOr(configured.silence_duration_ms, 500),
                create_response: false,
                interrupt_response: false,
            };
        }

        return {
            type: configured.type || "server_vad",
            threshold: numberOr(configured.threshold, env.realtimeVadThreshold),
            prefix_padding_ms: numberOr(configured.prefix_padding_ms, 300),
            silence_duration_ms: numberOr(configured.silence_duration_ms, 500),
            create_response: configured.create_response !== false,
            interrupt_response: configured.interrupt_response !== false,
        };
    }

    interruptionDebounceMs() {
        const configured = this.realtime.interruption_debounce_ms;

        return Math.max(0, numberOr(configured, env.realtimeInterruptDebounceMs));
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
        this.playInitialGreeting("remote_track_attached").catch((error) => {
            this.log("realtime initial greeting failed", {
                reason: "remote_track_attached",
                error: error.message,
            });
        });

        track.onended = () => {
            this.close("remote_track_ended").catch((error) => {
                console.error("Error closing ended realtime call session", error);
            });
        };
    }

    handleAudioData(data) {
        if (this.closedAt) {
            return;
        }

        this.remoteAudioFramesReceived += 1;

        if (this.humanTransferActive) {
            this.sendMetaAudioToAgentWebSocket(data);
            return;
        }

        if (!this.realtimeReady) {
            return;
        }

        if (this.notificationOnly) {
            this.playInitialGreeting("remote_audio_received").catch((error) => {
                this.log("realtime initial greeting failed", {
                    reason: "remote_audio_received",
                    error: error.message,
                });
            });
            return;
        }

        this.trackInputSpeech(data);

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

    trackInputSpeech(data) {
        const sampleRate = data.sampleRate || META_SAMPLE_RATE;
        const channelCount = data.channelCount || 1;
        const durationMs = (data.samples.length / channelCount / sampleRate) * 1000;
        const level = calculateRms(data.samples);
        const now = Date.now();
        const windowMs = Math.max(1, env.realtimeInterruptWindowMs);

        this.lastInputLevel = level;
        this.inputSpeechFrames.push({
            at: now,
            durationMs,
            hasSpeech: level >= env.realtimeInterruptRmsThreshold,
        });

        this.inputSpeechFrames = this.inputSpeechFrames.filter(
            (frame) => frame.at >= now - windowMs
        );
    }

    hasConfirmedInputSpeech() {
        const now = Date.now();
        const windowMs = Math.max(1, env.realtimeInterruptWindowMs);
        const speechMs = this.inputSpeechFrames
            .filter((frame) => frame.at >= now - windowMs && frame.hasSpeech)
            .reduce((total, frame) => total + frame.durationMs, 0);
        const confirmed = speechMs >= env.realtimeInterruptMinSpeechMs;

        if (!confirmed) {
            this.log("realtime interruption rejected by local audio check", {
                speech_ms: Math.round(speechMs),
                min_speech_ms: env.realtimeInterruptMinSpeechMs,
                last_level: Number(this.lastInputLevel.toFixed(5)),
                rms_threshold: env.realtimeInterruptRmsThreshold,
            });
        }

        return confirmed;
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
                if (this.notificationOnly) {
                    this.log("notification realtime audio delta ignored", {
                        response_id: event.response_id,
                        item_id: event.item_id,
                    });
                    break;
                }
                this.playRealtimeAudio(event);
                break;
            case "response.output_audio.done":
            case "response.done":
                this.outputActive = false;
                this.lastPlaybackAt = Date.now();
                this.markActivity("realtime_response_done");
                if (this.pendingHumanTransferRealtimeClose) {
                    this.closeRealtimeForHumanTransfer("human_transfer_message_done");
                }
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
                this.interruptionGate.speechStarted("user_speech_started");
                break;
            case "input_audio_buffer.speech_stopped":
                this.interruptionGate.speechStopped("speech_stopped_before_debounce");
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
        this.log("realtime tool call started", {
            name: event.name,
            tool_call_id: event.call_id,
            tenant: this.tenant,
            argument_keys: Object.keys(args),
        });

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
        this.log("realtime tool call completed", {
            name: event.name,
            tool_call_id: event.call_id,
            ok: result.ok,
            success: result.data && result.data.success,
            transferred: result.data && result.data.transferred,
            status: result.status || (result.data && result.data.status) || null,
            message: result.message || (result.data && result.data.message) || null,
            options_count: Array.isArray(result.data && result.data.options)
                ? result.data.options.length
                : null,
            appointments_count: Array.isArray(result.data && result.data.appointments)
                ? result.data.appointments.length
                : null,
            matches_count: Array.isArray(result.data && result.data.matches)
                ? result.data.matches.length
                : null,
        });

        if (generation !== this.toolGeneration || this.closedAt) {
            this.log("realtime tool result ignored after interruption", {
                name: event.name,
                call_id: event.call_id,
            });
            return;
        }

        const transferMessage = result.data && result.data.transferred
            ? String(result.data.message || "")
            : "";

        if (transferMessage) {
            this.humanTransferActive = true;
            this.markActivity("human_transfer_requested");
            this.log("realtime human transfer activated", {
                tool_call_id: event.call_id,
                agent_id: result.data.agent && result.data.agent.id,
            });
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
                ...(transferMessage
                    ? {
                        instructions: `Di exactamente este mensaje y no agregues nada mas: "${transferMessage}"`,
                    }
                    : {}),
            },
        });

        if (transferMessage) {
            this.pendingHumanTransferRealtimeClose = true;
            setTimeout(() => {
                if (this.pendingHumanTransferRealtimeClose && !this.realtimeClosedForHumanTransfer) {
                    this.closeRealtimeForHumanTransfer("human_transfer_ready_timeout");
                }
            }, 8000);
        }
    }

    attachAgentWebSocket(ws, options = {}) {
        if (this.closedAt) {
            ws.close(1011, "session_closed");
            return;
        }

        if (!this.humanTransferActive) {
            ws.close(1011, "human_transfer_not_active");
            return;
        }

        if (this.agentWs && this.agentWs.readyState === 1) {
            this.agentWs.close(1000, "agent_replaced");
        }

        this.agentWs = ws;
        this.activeAgentId = options.agentId || options.agent_id || this.activeAgentId;
        this.status = "agent_ws_connected";
        this.markActivity("agent_ws_connected");

        if (this.audioOutput) {
            this.audioOutput.stop();
        }

        this.log("realtime human transfer agent websocket connected", {
            agent_id: this.activeAgentId,
        });

        ws.on("message", (message, isBinary) => {
            if (!isBinary || this.closedAt || !this.audioSource) {
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

            this.agentWsFramesReceived += 1;
            this.markActivity("agent_ws_audio");

            if (this.agentWsFramesReceived === 1 || this.agentWsFramesReceived % 250 === 0) {
                this.log("realtime human transfer agent websocket audio received", {
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
            this.log("realtime human transfer agent websocket closed", {
                agent_id: this.activeAgentId,
                code,
                reason: reason ? reason.toString() : "",
            });
        });

        ws.on("error", (error) => {
            this.log("realtime human transfer agent websocket error", {
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
                this.log("realtime human transfer meta audio sent to agent websocket", {
                    agent_id: this.activeAgentId,
                    frames: this.metaWsFramesSent,
                    bytes: buffer.length,
                });
            }
        } catch (error) {
            this.log("realtime human transfer agent websocket send failed", {
                error: error.message,
            });
        }
    }

    sendAgentSamplesToMeta(samples) {
        if (!this.audioSource || !samples || samples.length === 0) {
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
            this.audioSource.onData({
                samples: new Int16Array(samples.subarray(offset, offset + RTC_AUDIO_FRAME_SAMPLES)),
                sampleRate: META_SAMPLE_RATE,
                bitsPerSample: 16,
                channelCount: 1,
                numberOfFrames: RTC_AUDIO_FRAME_SAMPLES,
            });
        }

        if (completeFramesLength !== samples.length) {
            this.agentWsSampleRemainder = new Int16Array(samples.subarray(completeFramesLength));
        }
    }

    closeRealtimeForHumanTransfer(reason = "human_transfer_ready") {
        this.realtimeClosedForHumanTransfer = true;
        this.pendingHumanTransferRealtimeClose = false;
        this.realtimeReady = false;
        this.outputActive = false;
        this.currentResponseId = null;
        this.currentAssistantItemId = null;
        this.interruptionGate.cancelPending();

        if (this.realtimeSocket && this.realtimeSocket.readyState !== WebSocket.CLOSED) {
            this.realtimeSocket.close(1000, reason);
        }
    }

    handleInterruption(reason = "interrupted") {
        const hasActiveResponse = this.outputActive && this.currentResponseId;
        this.toolGeneration += 1;
        this.outputActive = false;

        if (this.audioOutput) {
            this.audioOutput.clear(reason);
        }

        if (hasActiveResponse) {
            this.sendRealtimeEvent({
                type: "response.cancel",
            });
        }

        if (hasActiveResponse && this.currentAssistantItemId) {
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

    async playInitialGreeting(reason = "playback_ready") {
        if (
            !this.initialGreeting ||
            this.initialGreetingPlaybackPreparing ||
            this.initialGreetingPlaybackStarted ||
            this.initialGreetingPlayed ||
            this.closedAt
        ) {
            return false;
        }

        if (!this.realtimeReady || !this.audioOutput || !this.pc) {
            this.log("realtime initial greeting deferred until playback is ready", {
                reason,
                realtime_ready: this.realtimeReady,
                has_audio_output: Boolean(this.audioOutput),
                has_peer_connection: Boolean(this.pc),
            });

            return false;
        }

        this.initialGreetingPlaybackPreparing = true;
        this.initialGreetingPending = true;

        try {
            const playbackReady = await this.waitForPlaybackReady();

            if (!playbackReady || this.closedAt) {
                this.log("realtime initial greeting deferred until ICE is ready", {
                    reason,
                    playback_ready: playbackReady,
                    connection_state: this.pc ? this.pc.connectionState : null,
                    ice_connection_state: this.pc ? this.pc.iceConnectionState : null,
                });
                return false;
            }

            this.initialGreetingPlaybackStarted = true;
            this.log("realtime initial greeting requested", {
                reason,
                text_length: this.initialGreeting.length,
                notification_only: this.notificationOnly,
            });

            if (this.notificationOnly) {
                await this.playNotificationGreetingAudio(this.initialGreeting, reason);
                this.initialGreetingPlayed = true;

                return true;
            }

            this.sendRealtimeEvent({
                type: "response.create",
                response: {
                    output_modalities: ["audio"],
                    instructions: `Di exactamente este saludo inicial, sin agregar frases, preguntas ni informacion adicional: "${this.initialGreeting}"`,
                },
            });
            this.initialGreetingPlayed = true;

            return true;
        } finally {
            this.initialGreetingPlaybackPreparing = false;
            this.initialGreetingPending = false;
        }
    }

    async playNotificationGreetingAudio(text, reason) {
        // Some voices (e.g. "marin") exist only in the OpenAI Realtime API and
        // are NOT accepted by the standard TTS HTTP endpoint — sending them
        // causes a 400 error that silently aborts playback.  Map them to the
        // closest valid TTS voice before calling synthesize().
        const ttsVoice = toTtsVoice(this.voice());

        this.log("notification initial greeting TTS requested", {
            reason,
            text_length: text.length,
            voice: this.voice(),
            tts_voice: ttsVoice,
        });

        const ttsResult = await ttsService.synthesize(
            {
                text,
                voice: ttsVoice,
                format: "mp3",
                instructions: "Lee este mensaje de notificacion de forma natural. No agregues saludos, preguntas ni frases finales.",
            },
            {
                baseUrl: this.baseUrl,
            }
        );

        if (!ttsResult.audio_url) {
            throw new Error("Notification initial greeting TTS did not return audio_url");
        }

        this.outputActive = true;

        let playback = null;

        try {
            if (env.callInitialPlaybackPrerollMs > 0) {
                this.log("waiting before initial notification playback", {
                    reason,
                    delay_ms: env.callInitialPlaybackPrerollMs,
                });
                await this.wait(env.callInitialPlaybackPrerollMs);
            }

            playback = await this.audioOutput.enqueueAudioUrl(ttsResult.audio_url, {
                source: "notification_initial_greeting",
                reason,
            });
        } finally {
            this.outputActive = false;
            this.inputMutedUntil = Date.now() + env.callPostPlaybackMuteMs;
            this.markActivity("notification_initial_greeting_played");
            this.lastPlaybackAt = this.lastActivityAt;
        }

        this.log("notification initial greeting playback complete", {
            reason,
            audio_url: ttsResult.audio_url,
            frames_sent: playback ? playback.framesSent : null,
            frames_queued: playback ? playback.framesQueued : null,
            pcm_bytes: playback ? playback.pcmBytes : null,
            bytes_downloaded: playback ? playback.bytesDownloaded : null,
            stopped: playback ? playback.stopped : null,
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

    async sendCallback(payload) {
        if (!this.callbackUrl) {
            return null;
        }

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

    waitForPlaybackReady() {
        if (this.isIceReady()) {
            return Promise.resolve(true);
        }

        this.log("realtime waiting for ICE before playback", {
            connection_state: this.pc ? this.pc.connectionState : null,
            ice_connection_state: this.pc ? this.pc.iceConnectionState : null,
            timeout_ms: env.callPlaybackWaitForIceMs,
        });

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                cleanup();
                this.log("realtime playback continuing without connected ICE", {
                    connection_state: this.pc ? this.pc.connectionState : null,
                    ice_connection_state: this.pc ? this.pc.iceConnectionState : null,
                });
                resolve(false);
            }, env.callPlaybackWaitForIceMs);

            const cleanup = () => {
                clearTimeout(timeout);

                if (this.pc && this.pc.removeEventListener) {
                    this.pc.removeEventListener("connectionstatechange", onStateChange);
                    this.pc.removeEventListener("iceconnectionstatechange", onStateChange);
                }
            };

            const onStateChange = () => {
                if (this.isIceReady()) {
                    cleanup();
                    this.log("realtime ICE ready for playback", {
                        connection_state: this.pc ? this.pc.connectionState : null,
                        ice_connection_state: this.pc ? this.pc.iceConnectionState : null,
                    });
                    resolve(true);
                }
            };

            if (this.pc && this.pc.addEventListener) {
                this.pc.addEventListener("connectionstatechange", onStateChange);
                this.pc.addEventListener("iceconnectionstatechange", onStateChange);
            }
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
        this.closeReason = reason;
        this.interruptionGate.cancelPending();

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

        await this.sendCallback({
            event: "ended",
            session_id: this.sessionId,
            call_id: this.callId,
            reason,
            tenant: this.tenant,
            agent_id: this.agentId,
            notification_only: this.notificationOnly,
            hangup_meta: this.hangupAfterInitialGreeting,
        }).catch((error) => {
            console.error("Error sending realtime ended callback", error.message);
        });

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
            return;
        }

        if (state === "connected") {
            this.playInitialGreeting("peer_connection_connected").catch((error) => {
                this.log("realtime initial greeting failed", {
                    reason: "peer_connection_connected",
                    error: error.message,
                });
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
            return;
        }

        if (["connected", "completed"].includes(state)) {
            this.playInitialGreeting("ice_connected").catch((error) => {
                this.log("realtime initial greeting failed", {
                    reason: "ice_connected",
                    error: error.message,
                });
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
            initial_greeting_configured: Boolean(this.initialGreeting),
            initial_greeting_pending: this.initialGreetingPending,
            initial_greeting_played: this.initialGreetingPlayed,
            notification_only: this.notificationOnly,
            hangup_after_initial_greeting: this.hangupAfterInitialGreeting,
            created_at: this.createdAt.toISOString(),
            closed_at: this.closedAt ? this.closedAt.toISOString() : null,
            callback_url: this.callbackUrl,
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
        const base = this.realtime.instructions || "Eres un agente de voz de EVA. Responde en espanol con frases breves y naturales.";

        if (this.notificationOnly) {
            return base;
        }

        return `${base}

Transferencia a humano:
- Si el cliente pide hablar con una persona, asesor, soporte, recepcion o agente humano, usa la herramienta transfer_to_human con trigger "customer_request".
- Si no estas entendiendo la solicitud o el cliente repite que no le entendiste, usa transfer_to_human con trigger "ai_confusion".
- Si detectas molestia, frustracion o enojo, usa transfer_to_human con trigger "customer_frustrated".
- Nunca digas que no puedes transferir. Usa la herramienta y luego di exactamente el mensaje devuelto por la herramienta.`;
    }

    markActivity(type) {
        this.lastActivityAt = Date.now();
        this.lastActivityType = type;
    }

    wait(ms) {
        return wait(ms);
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

function calculateRms(samples) {
    if (!samples || !samples.length) {
        return 0;
    }

    let sumSquares = 0;

    for (let index = 0; index < samples.length; index += 1) {
        const normalized = samples[index] / 32768;
        sumSquares += normalized * normalized;
    }

    return Math.sqrt(sumSquares / samples.length);
}

function normalizeInitialGreeting(value) {
    if (typeof value !== "string") {
        return "";
    }

    return value.replace(/\s+/g, " ").trim();
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

// Voices available only in the OpenAI Realtime API → closest TTS HTTP equivalent.
// The TTS HTTP endpoint rejects any voice not in its own list and returns a 400
// that, when uncaught inside playNotificationGreetingAudio, silently prevents
// the notification audio from being enqueued.
const REALTIME_TO_TTS_VOICE_MAP = {
    marin: "nova",
    // Add further mappings here if new Realtime-only voices are introduced.
};

// Valid voices for the standard TTS HTTP endpoint (audio.speech.create).
const TTS_HTTP_VOICES = new Set([
    "alloy", "ash", "ballad", "coral", "echo", "fable",
    "nova", "onyx", "sage", "shimmer", "verse", "cedar",
]);

function toTtsVoice(voice) {
    if (TTS_HTTP_VOICES.has(voice)) {
        return voice;
    }

    return REALTIME_TO_TTS_VOICE_MAP[voice] || "nova";
}

module.exports = RealtimeCallSession;
module.exports._private = {
    resamplePcm16,
    parseJsonObject,
    realtimeErrorMessage,
};
