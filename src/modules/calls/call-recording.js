const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const axios = require("axios");

const env = require("../../config/env");
const sttService = require("../stt/stt.service");
const { createWavBuffer, int16ArrayToBuffer } = require("./wav.util");

const SAMPLE_RATE = 48000;
const BYTES_PER_SAMPLE = 2;
const CHANNELS = {
    customer: {
        label: "Cliente",
        side: "customer",
    },
    agent: {
        label: "Agente",
        side: "agent",
    },
};

class CallRecording {
    constructor(options = {}) {
        this.enabled = env.callRecordingEnabled !== false;
        this.sessionId = options.sessionId || "";
        this.callId = options.callId || "";
        this.tenant = options.tenant || null;
        this.agentId = options.agentId || null;
        this.callbackUrl = options.callbackUrl || null;
        this.baseUrl = options.baseUrl || "";
        this.mode = options.mode || "voice";
        this.logger = options.logger || null;
        this.startedAt = new Date();
        this.closedAt = null;
        this.finalized = false;
        this.rawDir = path.join(env.ttsOutputDir, "recordings");
        this.safeSessionId = safeName(this.sessionId || `${Date.now()}`);
        this.sources = {
            customer: this.createSource("customer"),
            agent: this.createSource("agent"),
        };
        this.transcriptSegments = [];
    }

    createSource(source) {
        return {
            source,
            rawPath: path.join(this.rawDir, `${this.safeSessionId}-${source}.pcm`),
            stream: null,
            samplesWritten: 0,
            frames: 0,
            audioBytes: 0,
        };
    }

    recordCustomerData(data) {
        this.recordRtcData("customer", data);
    }

    recordAgentData(data) {
        this.recordRtcData("agent", data);
    }

    recordAgentSamples(samples, options = {}) {
        this.recordSamples("agent", samples, options);
    }

    recordAgentPcm(pcmBuffer, options = {}) {
        this.recordPcm("agent", pcmBuffer, options);
    }

    addTranscriptSegment(role, text, event = {}) {
        text = String(text || "").trim();

        if (!text) {
            return;
        }

        const side = ["assistant", "asistente", "agent", "agente"].includes(String(role || "").toLowerCase())
            ? "agent"
            : "customer";
        const channel = CHANNELS[side];

        this.transcriptSegments.push({
            speaker: channel.label,
            side: channel.side,
            text,
            event: event.type || null,
            event_id: event.event_id || null,
            at_ms: this.elapsedMs(),
        });
    }

    recordRtcData(source, data) {
        if (!data || !data.samples) {
            return;
        }

        this.recordSamples(source, data.samples, {
            sampleRate: data.sampleRate,
            channelCount: data.channelCount,
        });
    }

    recordSamples(source, samples, options = {}) {
        if (!samples || samples.length === 0) {
            return;
        }

        this.recordPcm(source, int16ArrayToBuffer(samples), {
            sampleRate: options.sampleRate,
            channelCount: options.channelCount,
        });
    }

    recordPcm(source, pcmBuffer, options = {}) {
        if (!this.enabled || this.finalized || !pcmBuffer || !pcmBuffer.length) {
            return;
        }

        if (!CHANNELS[source]) {
            return;
        }

        try {
            this.ensureSourceStream(source);
            const normalized = normalizePcm(pcmBuffer, {
                sampleRate: options.sampleRate || SAMPLE_RATE,
                channelCount: options.channelCount || 1,
            });

            if (!normalized.length) {
                return;
            }

            const state = this.sources[source];
            const targetSamples = Math.max(
                state.samplesWritten,
                Math.round((this.elapsedMs() * SAMPLE_RATE) / 1000)
            );
            const gapSamples = targetSamples - state.samplesWritten;

            if (gapSamples > 0) {
                writeSilence(state.stream, gapSamples);
                state.samplesWritten += gapSamples;
            }

            state.stream.write(normalized);
            state.samplesWritten += normalized.length / BYTES_PER_SAMPLE;
            state.frames += 1;
            state.audioBytes += normalized.length;
        } catch (error) {
            this.log("call recording frame ignored", {
                source,
                error: error.message,
            });
        }
    }

    ensureSourceStream(source) {
        const state = this.sources[source];

        if (state.stream) {
            return;
        }

        fs.mkdirSync(this.rawDir, { recursive: true });
        state.stream = fs.createWriteStream(state.rawPath);
    }

    async finalize(reason = "closed") {
        if (!this.enabled || this.finalized) {
            return null;
        }

        this.finalized = true;
        this.closedAt = new Date();

        try {
            const result = await this.buildRecording(reason);

            if (this.callbackUrl && result) {
                await this.sendRecordingCallback(result).catch((error) => {
                    this.log("call recording callback failed", {
                        error: error.message,
                    });
                });
            }

            return result;
        } catch (error) {
            this.log("call recording finalize failed", {
                error: error.message,
            });

            return null;
        }
    }

    async buildRecording(reason) {
        const sources = Object.values(this.sources);
        const maxSamples = Math.max(0, ...sources.map((source) => source.samplesWritten));

        if (maxSamples <= 0) {
            return null;
        }

        for (const source of sources) {
            this.ensureSourceStream(source.source);

            if (source.samplesWritten < maxSamples) {
                writeSilence(source.stream, maxSamples - source.samplesWritten);
                source.samplesWritten = maxSamples;
            }

            await closeStream(source.stream);
            source.stream = null;
        }

        const customerPcm = await fsp.readFile(this.sources.customer.rawPath);
        const agentPcm = await fsp.readFile(this.sources.agent.rawPath);
        const mixedPcm = mixMono(customerPcm, agentPcm);
        const filename = `recording-${this.safeSessionId}.wav`;
        const filePath = path.join(env.ttsOutputDir, filename);
        const wav = createWavBuffer(mixedPcm, {
            sampleRate: SAMPLE_RATE,
            channelCount: 1,
        });

        await fsp.writeFile(filePath, wav);

        const transcriptSegments = await this.resolveTranscriptSegments(customerPcm, agentPcm);
        const durationSeconds = Math.round(maxSamples / SAMPLE_RATE);

        await this.cleanupRawFiles();

        return {
            filePath,
            filename,
            audioUrl: this.buildAudioUrl(filename),
            mimeType: "audio/wav",
            sizeBytes: wav.length,
            durationSeconds,
            startedAt: this.startedAt.toISOString(),
            endedAt: this.closedAt.toISOString(),
            reason,
            transcriptSegments,
            transcript: transcriptSegments.map((segment) => `${segment.speaker}: ${segment.text}`).join("\n"),
            metadata: {
                mode: this.mode,
                sample_rate: SAMPLE_RATE,
                channels: {
                    mixed: [CHANNELS.customer.label, CHANNELS.agent.label],
                },
                playback_mix: "mono_centered",
                customer_frames: this.sources.customer.frames,
                agent_frames: this.sources.agent.frames,
            },
        };
    }

    async resolveTranscriptSegments(customerPcm, agentPcm) {
        const segments = [];

        if (env.callRecordingTranscribe) {
            segments.push(...await this.transcribeSource("customer", customerPcm));
            segments.push(...await this.transcribeSource("agent", agentPcm));
        }

        if (segments.length > 0) {
            return segments;
        }

        return this.transcriptSegments;
    }

    async transcribeSource(source, pcmBuffer) {
        const state = this.sources[source];

        if (!state || state.audioBytes <= 0 || !pcmBuffer.length) {
            return [];
        }

        const channel = CHANNELS[source];
        const filename = `recording-${this.safeSessionId}-${source}.wav`;
        const filePath = path.join(this.rawDir, filename);
        const wav = createWavBuffer(pcmBuffer, {
            sampleRate: SAMPLE_RATE,
            channelCount: 1,
        });

        await fsp.writeFile(filePath, wav);

        try {
            const result = await sttService.transcribe({
                file: {
                    path: filePath,
                    originalname: filename,
                    mimetype: "audio/wav",
                    size: wav.length,
                },
                body: {
                    language: env.callAudioLanguage || "es",
                    prompt: `Transcribe solamente la voz de ${channel.label} en esta llamada. No inventes texto si hay silencio.`,
                },
                cleanup: false,
            });
            const text = String(result.text || "").trim();

            if (!text) {
                return [];
            }

            return [{
                speaker: channel.label,
                side: channel.side,
                text,
                start_ms: 0,
                end_ms: Math.round((state.samplesWritten / SAMPLE_RATE) * 1000),
                provider: result.provider || null,
                model: result.model || null,
            }];
        } catch (error) {
            this.log("call recording source transcription failed", {
                source,
                error: error.message,
            });

            return [];
        } finally {
            await fsp.unlink(filePath).catch(() => {});
        }
    }

    async sendRecordingCallback(result) {
        const response = await axios.post(
            this.callbackUrl,
            {
                event: "recording",
                session_id: this.sessionId,
                call_id: this.callId,
                tenant: this.tenant,
                agent_id: this.agentId,
                recording: {
                    audio_url: result.audioUrl,
                    mime_type: result.mimeType,
                    size_bytes: result.sizeBytes,
                    duration_seconds: result.durationSeconds,
                    started_at: result.startedAt,
                    ended_at: result.endedAt,
                    transcript: result.transcript,
                    transcript_segments: result.transcriptSegments,
                    metadata: result.metadata,
                },
            },
            {
                headers: {
                    Accept: "application/json",
                    "Content-Type": "application/json",
                    Authorization: env.voiceApiToken ? `Bearer ${env.voiceApiToken}` : undefined,
                },
                timeout: env.callCallbackTimeoutMs,
            }
        );

        return response.data;
    }

    async cleanupRawFiles() {
        await Promise.all(
            Object.values(this.sources).map((source) => fsp.unlink(source.rawPath).catch(() => {}))
        );
    }

    buildAudioUrl(filename) {
        const relativeUrl = `/api/audio/${filename}`;

        if (!this.baseUrl) {
            return relativeUrl;
        }

        return `${this.baseUrl.replace(/\/$/, "")}${relativeUrl}`;
    }

    elapsedMs() {
        return Math.max(0, Date.now() - this.startedAt.getTime());
    }

    log(message, data = {}) {
        if (this.logger) {
            this.logger(message, data);
        }
    }
}

function normalizePcm(buffer, options = {}) {
    let pcm = Buffer.from(buffer);
    const channelCount = Math.max(1, Number(options.channelCount || 1));
    const sampleRate = Math.max(1, Number(options.sampleRate || SAMPLE_RATE));

    if (channelCount > 1) {
        pcm = downmixToMono(pcm, channelCount);
    }

    if (sampleRate !== SAMPLE_RATE) {
        pcm = resamplePcm16(pcm, sampleRate, SAMPLE_RATE);
    }

    return pcm;
}

function downmixToMono(buffer, channelCount) {
    const inputSamples = Math.floor(buffer.length / BYTES_PER_SAMPLE);
    const outputSamples = Math.floor(inputSamples / channelCount);
    const output = Buffer.alloc(outputSamples * BYTES_PER_SAMPLE);

    for (let frame = 0; frame < outputSamples; frame += 1) {
        let total = 0;

        for (let channel = 0; channel < channelCount; channel += 1) {
            total += buffer.readInt16LE((frame * channelCount + channel) * BYTES_PER_SAMPLE);
        }

        output.writeInt16LE(clampInt16(Math.round(total / channelCount)), frame * BYTES_PER_SAMPLE);
    }

    return output;
}

function resamplePcm16(buffer, fromRate, toRate) {
    if (!buffer.length || fromRate === toRate) {
        return buffer;
    }

    const inputSamples = Math.floor(buffer.length / BYTES_PER_SAMPLE);
    const outputSamples = Math.max(1, Math.round((inputSamples * toRate) / fromRate));
    const output = Buffer.alloc(outputSamples * BYTES_PER_SAMPLE);

    for (let index = 0; index < outputSamples; index += 1) {
        const sourceIndex = Math.min(
            inputSamples - 1,
            Math.floor((index * fromRate) / toRate)
        );

        output.writeInt16LE(buffer.readInt16LE(sourceIndex * BYTES_PER_SAMPLE), index * BYTES_PER_SAMPLE);
    }

    return output;
}

function mixMono(customerPcm, agentPcm) {
    const samples = Math.max(customerPcm.length, agentPcm.length) / BYTES_PER_SAMPLE;
    const output = Buffer.alloc(samples * BYTES_PER_SAMPLE);

    for (let index = 0; index < samples; index += 1) {
        const offset = index * BYTES_PER_SAMPLE;
        const customer = offset < customerPcm.length
            ? customerPcm.readInt16LE(offset)
            : 0;
        const agent = offset < agentPcm.length
            ? agentPcm.readInt16LE(offset)
            : 0;
        const mixed = customer !== 0 && agent !== 0
            ? Math.round((customer + agent) / 2)
            : customer + agent;

        output.writeInt16LE(clampInt16(mixed), offset);
    }

    return output;
}

function writeSilence(stream, samples) {
    let remaining = Math.max(0, Math.floor(samples)) * BYTES_PER_SAMPLE;
    const chunk = Buffer.alloc(Math.min(remaining, SAMPLE_RATE * BYTES_PER_SAMPLE));

    while (remaining > 0) {
        const bytes = Math.min(remaining, chunk.length);
        stream.write(bytes === chunk.length ? chunk : Buffer.alloc(bytes));
        remaining -= bytes;
    }
}

function closeStream(stream) {
    return new Promise((resolve, reject) => {
        stream.once("error", reject);
        stream.end(resolve);
    });
}

function safeName(value) {
    return String(value || "")
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 120) || `session-${Date.now()}`;
}

function clampInt16(value) {
    return Math.max(-32768, Math.min(32767, value));
}

module.exports = {
    CallRecording,
};
