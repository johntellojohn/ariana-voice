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
        this.frameSamples = Math.round((this.sampleRate * this.frameMs) / 1000);
        this.frameBytes = this.frameSamples * this.channelCount * 2;
        this.buffer = Buffer.alloc(0);
        this.timer = null;
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
    }

    enqueuePcm(pcmBuffer) {
        if (!pcmBuffer || !pcmBuffer.length) {
            return;
        }

        this.buffer = Buffer.concat([this.buffer, pcmBuffer]);
    }

    async enqueueFile(filePath) {
        const pcm = await convertToPcm(filePath, {
            sampleRate: this.sampleRate,
            channelCount: this.channelCount,
        });

        this.enqueuePcm(pcm);
    }

    tick() {
        let frame = Buffer.alloc(this.frameBytes);

        if (this.buffer.length >= this.frameBytes) {
            frame = this.buffer.subarray(0, this.frameBytes);
            this.buffer = this.buffer.subarray(this.frameBytes);
        } else if (this.buffer.length > 0) {
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

    return filePath;
}

module.exports = {
    AudioOutput,
    convertToPcm,
    downloadAudioToTemp,
};
