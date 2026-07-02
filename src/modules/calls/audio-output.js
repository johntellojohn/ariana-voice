const { execFile } = require("child_process");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

class AudioOutput {
    constructor(source, options = {}) {
        this.source = source;
        this.sampleRate = options.sampleRate || 48000;
        this.channelCount = options.channelCount || 1;
        this.frameMs = options.frameMs || 10;
        this.logger = options.logger || null;
        this.onAudioFrame = typeof options.onAudioFrame === "function" ? options.onAudioFrame : null;
        this.logAudioChunks = Boolean(options.logAudioChunks);
        this.frameSamples = Math.round((this.sampleRate * this.frameMs) / 1000);
        this.frameBytes = this.frameSamples * this.channelCount * 2;
        this.silenceLogEveryFrames =
            options.silenceLogEveryFrames === undefined
                ? 6000
                : Number(options.silenceLogEveryFrames);
        this.buffer = Buffer.alloc(0);
        this.timer = null;
        this.playbackJobs = [];
        this.playbackJobId = 0;
        this.silenceFramesSent = 0;
        this.audioFramesSent = 0;
    }

    start() {
        if (this.timer) {
            return;
        }

        this.timer = setInterval(() => this.tick(), this.frameMs);
        this.log("silence pump started", {
            sample_rate: this.sampleRate,
            channel_count: this.channelCount,
            frame_ms: this.frameMs,
            frame_samples: this.frameSamples,
            frame_bytes: this.frameBytes,
            silence_log_every_frames: this.silenceLogEveryFrames,
        });
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }

        this.clear("stopped");
        this.log("silence pump stopped", {
            silence_frames_sent: this.silenceFramesSent,
            audio_frames_sent: this.audioFramesSent,
            pending_jobs: this.playbackJobs.length,
        });
    }

    clear(reason = "cleared") {
        const pendingJobs = this.playbackJobs.length;
        const pendingBytes = this.buffer.length;

        this.buffer = Buffer.alloc(0);
        while (this.playbackJobs.length) {
            const job = this.playbackJobs.shift();
            job.resolve({
                id: job.id,
                stopped: true,
                reason,
                framesSent: job.framesSent,
                framesQueued: job.framesQueued,
                pcmBytes: job.pcmBytes,
                paddedBytes: job.paddedBytes,
                metadata: job.metadata,
            });
        }

        this.log("audio output cleared", {
            reason,
            pending_jobs: pendingJobs,
            pending_bytes: pendingBytes,
        });
    }

    enqueuePcm(pcmBuffer, metadata = {}) {
        if (!pcmBuffer || !pcmBuffer.length) {
            return Promise.resolve({
                framesQueued: 0,
                framesSent: 0,
                pcmBytes: 0,
                metadata,
            });
        }

        const paddedBuffer = this.padToFrameBoundary(pcmBuffer);
        const framesQueued = paddedBuffer.length / this.frameBytes;
        const id = this.playbackJobId + 1;
        this.playbackJobId = id;
        this.buffer = Buffer.concat([this.buffer, paddedBuffer]);

        if (this.logAudioChunks) {
            this.log("audio output queued", {
                id,
                pcm_bytes: pcmBuffer.length,
                padded_bytes: paddedBuffer.length,
                frames_queued: framesQueued,
                frame_ms: this.frameMs,
                sample_rate: this.sampleRate,
                channel_count: this.channelCount,
                metadata,
            });
        }

        return new Promise((resolve) => {
            this.playbackJobs.push({
                id,
                metadata,
                resolve,
                pcmBytes: pcmBuffer.length,
                paddedBytes: paddedBuffer.length,
                bytesRemaining: paddedBuffer.length,
                framesQueued,
                framesSent: 0,
                startedAt: Date.now(),
            });
        });
    }

    async enqueueFile(filePath, metadata = {}) {
        this.log("ffmpeg pcm conversion start", {
            file_path: filePath,
            sample_rate: this.sampleRate,
            channel_count: this.channelCount,
            format: "s16le",
            metadata,
        });

        let pcm;

        try {
            pcm = await convertToPcm(filePath, {
                sampleRate: this.sampleRate,
                channelCount: this.channelCount,
            });
        } catch (error) {
            this.log("ffmpeg pcm conversion error", {
                file_path: filePath,
                error: error.message,
                metadata,
            });
            throw error;
        }

        this.log("ffmpeg pcm conversion ok", {
            file_path: filePath,
            pcm_bytes: pcm.length,
            frames: Math.ceil(pcm.length / this.frameBytes),
            metadata,
        });

        return this.enqueuePcm(pcm, metadata);
    }

    async enqueueAudioBuffer(audioBuffer, metadata = {}) {
        if (!audioBuffer || !audioBuffer.length) {
            return {
                framesQueued: 0,
                framesSent: 0,
                pcmBytes: 0,
                metadata,
            };
        }

        const extension = normalizeAudioExtension(metadata.extension || metadata.format);
        const filePath = path.join(
            os.tmpdir(),
            `ariana-call-audio-buffer-${Date.now()}-${Math.random().toString(16).slice(2)}.${extension}`
        );

        await fsp.writeFile(filePath, audioBuffer);

        this.log("audio buffer written for playback", {
            file_path: filePath,
            bytes: audioBuffer.length,
            extension,
            metadata,
        });

        try {
            const playback = await this.enqueueFile(filePath, {
                ...metadata,
                source_type: "buffer",
            });

            return {
                ...playback,
                bytesDownloaded: 0,
                contentType: metadata.mime_type || "",
            };
        } finally {
            await fsp.unlink(filePath).catch(() => {});
        }
    }

    async enqueueAudioUrl(audioUrl, metadata = {}) {
        const downloaded = await downloadAudioToTemp(audioUrl);

        this.log("agent audio_url downloaded", {
            audio_url: audioUrl,
            bytes_downloaded: downloaded.bytes,
            content_type: downloaded.contentType,
            file_path: downloaded.filePath,
            metadata,
        });

        try {
            const playback = await this.enqueueFile(downloaded.filePath, {
                ...metadata,
                audio_url: audioUrl,
            });

            return {
                ...playback,
                bytesDownloaded: downloaded.bytes,
                contentType: downloaded.contentType,
            };
        } finally {
            await fsp.unlink(downloaded.filePath).catch(() => {});
        }
    }

    tick() {
        const frame = Buffer.alloc(this.frameBytes);
        let audioBytesSent = 0;
        let frameType = "silence";

        if (this.buffer.length >= this.frameBytes) {
            this.buffer.copy(frame, 0, 0, this.frameBytes);
            this.buffer = this.buffer.subarray(this.frameBytes);
            audioBytesSent = this.frameBytes;
            frameType = "audio";
        } else if (this.buffer.length > 0) {
            audioBytesSent = this.buffer.length;
            this.buffer.copy(frame);
            this.buffer = Buffer.alloc(0);
            frameType = "audio";
        }

        const samples = bufferToExactInt16Frame(frame, this.frameSamples, this.channelCount);

        if (samples.byteLength !== this.frameBytes) {
            this.log("audio output invalid frame size", {
                frame_type: frameType,
                frame_bytes: frame.length,
                samples_byte_length: samples.byteLength,
                expected_byte_length: this.frameBytes,
                frame_samples: this.frameSamples,
                channel_count: this.channelCount,
            });
            return;
        }

        try {
            this.source.onData({
                samples,
                sampleRate: this.sampleRate,
                bitsPerSample: 16,
                channelCount: this.channelCount,
                numberOfFrames: this.frameSamples,
            });
        } catch (error) {
            this.log("audio output onData error", {
                error: error.message,
                frame_type: frameType,
            });
            return;
        }

        if (audioBytesSent > 0) {
            if (this.onAudioFrame) {
                try {
                    this.onAudioFrame(frame, {
                        sampleRate: this.sampleRate,
                        channelCount: this.channelCount,
                        frameMs: this.frameMs,
                    });
                } catch (error) {
                    this.log("audio output frame tap failed", {
                        error: error.message,
                    });
                }
            }

            this.audioFramesSent += 1;
            this.markPlaybackFrameSent(audioBytesSent);
        } else {
            this.silenceFramesSent += 1;

            if (
                this.silenceLogEveryFrames > 0 &&
                (this.silenceFramesSent === 1 ||
                    this.silenceFramesSent % this.silenceLogEveryFrames === 0)
            ) {
                this.log("silence pump alive", {
                    silence_frames_sent: this.silenceFramesSent,
                    audio_frames_sent: this.audioFramesSent,
                });
            }
        }
    }

    hasPendingAudio() {
        return this.buffer.length > 0 || this.playbackJobs.length > 0;
    }

    padToFrameBoundary(pcmBuffer) {
        const remainder = pcmBuffer.length % this.frameBytes;

        if (remainder === 0) {
            return pcmBuffer;
        }

        return Buffer.concat([
            pcmBuffer,
            Buffer.alloc(this.frameBytes - remainder),
        ]);
    }

    markPlaybackFrameSent(bytesSent) {
        let remaining = bytesSent;

        while (remaining > 0 && this.playbackJobs.length) {
            const job = this.playbackJobs[0];
            const consumed = Math.min(remaining, job.bytesRemaining);

            job.bytesRemaining -= consumed;
            remaining -= consumed;

            if (consumed > 0) {
                job.framesSent += 1;
            }

            if (job.bytesRemaining <= 0) {
                this.playbackJobs.shift();

                const result = {
                    id: job.id,
                    stopped: false,
                    framesSent: job.framesSent,
                    framesQueued: job.framesQueued,
                    pcmBytes: job.pcmBytes,
                    paddedBytes: job.paddedBytes,
                    durationMs: Date.now() - job.startedAt,
                    metadata: job.metadata,
                };

                if (this.logAudioChunks) {
                    this.log("audio output sent", {
                        id: result.id,
                        frames_sent: result.framesSent,
                        frames_queued: result.framesQueued,
                        pcm_bytes: result.pcmBytes,
                        padded_bytes: result.paddedBytes,
                        duration_ms: result.durationMs,
                        metadata: result.metadata,
                    });
                }

                job.resolve(result);
            }
        }
    }

    log(message, data = {}) {
        if (this.logger) {
            this.logger(message, data);
        }
    }
}

function normalizeAudioExtension(value) {
    const extension = String(value || "mp3").toLowerCase().replace(/^\./, "");

    return ["mp3", "wav", "opus", "aac", "flac"].includes(extension) ? extension : "mp3";
}

function bufferToExactInt16Frame(buffer, frameSamples, channelCount) {
    const sampleCount = frameSamples * channelCount;
    const samples = new Int16Array(sampleCount);
    const bytesToRead = Math.min(buffer.length, sampleCount * 2);

    for (let index = 0; index < bytesToRead / 2; index += 1) {
        samples[index] = buffer.readInt16LE(index * 2);
    }

    return samples;
}

function convertToPcm(filePath, options = {}) {
    const sampleRate = options.sampleRate || 48000;
    const channelCount = options.channelCount || 1;

    return new Promise((resolve, reject) => {
        execFile(
            "ffmpeg",
            [
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                filePath,
                "-f",
                "s16le",
                "-acodec",
                "pcm_s16le",
                "-ac",
                String(channelCount),
                "-ar",
                String(sampleRate),
                "pipe:1",
            ],
            {
                encoding: "buffer",
                maxBuffer: 20 * 1024 * 1024,
            },
            (error, stdout, stderr) => {
                if (error) {
                    error.message = `${error.message}: ${stderr ? stderr.toString() : ""}`;
                    return reject(error);
                }

                return resolve(stdout);
            }
        );
    });
}

async function downloadAudioToTemp(url) {
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Could not download audio_url: HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type") || "";
    const extension = contentType.includes("wav") ? "wav" : "mp3";
    const filePath = path.join(
        os.tmpdir(),
        `ariana-call-audio-${Date.now()}-${Math.random().toString(16).slice(2)}.${extension}`
    );
    const buffer = Buffer.from(await response.arrayBuffer());

    await fsp.writeFile(filePath, buffer);

    return {
        filePath,
        bytes: buffer.length,
        contentType,
    };
}

module.exports = {
    AudioOutput,
    convertToPcm,
    downloadAudioToTemp,
};
