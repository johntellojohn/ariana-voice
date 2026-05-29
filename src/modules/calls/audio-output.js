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
        this.frameSamples = Math.round((this.sampleRate * this.frameMs) / 1000);
        this.frameBytes = this.frameSamples * this.channelCount * 2;
        this.buffer = Buffer.alloc(0);
        this.timer = null;
        this.playbackJobs = [];
        this.playbackJobId = 0;
    }

    start() {
        if (this.timer) {
            return;
        }

        this.timer = setInterval(() => this.tick(), this.frameMs);
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }

        this.buffer = Buffer.alloc(0);

        while (this.playbackJobs.length) {
            const job = this.playbackJobs.shift();
            job.resolve({
                id: job.id,
                stopped: true,
                framesSent: job.framesSent,
                framesQueued: job.framesQueued,
                pcmBytes: job.pcmBytes,
                paddedBytes: job.paddedBytes,
                metadata: job.metadata,
            });
        }
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

    tick() {
        let frame = Buffer.alloc(this.frameBytes);
        let audioBytesSent = 0;

        if (this.buffer.length >= this.frameBytes) {
            frame = this.buffer.subarray(0, this.frameBytes);
            this.buffer = this.buffer.subarray(this.frameBytes);
            audioBytesSent = this.frameBytes;
        } else if (this.buffer.length > 0) {
            audioBytesSent = this.buffer.length;
            this.buffer.copy(frame);
            this.buffer = Buffer.alloc(0);
        }

        const samples = new Int16Array(
            frame.buffer,
            frame.byteOffset,
            frame.byteLength / 2
        );

        this.source.onData({
            samples,
            sampleRate: this.sampleRate,
            bitsPerSample: 16,
            channelCount: this.channelCount,
            numberOfFrames: this.frameSamples,
        });

        if (audioBytesSent > 0) {
            this.markPlaybackFrameSent(audioBytesSent);
        }
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

                this.log("audio output sent", {
                    id: result.id,
                    frames_sent: result.framesSent,
                    frames_queued: result.framesQueued,
                    pcm_bytes: result.pcmBytes,
                    padded_bytes: result.paddedBytes,
                    duration_ms: result.durationMs,
                    metadata: result.metadata,
                });

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
