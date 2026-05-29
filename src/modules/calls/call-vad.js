const { int16ArrayToBuffer } = require("./wav.util");

class CallVad {
    constructor(options = {}) {
        this.threshold = options.threshold || 0.015;
        this.silenceMs = options.silenceMs || 900;
        this.minSpeechMs = options.minSpeechMs || 450;
        this.maxTurnMs = options.maxTurnMs || 15000;
        this.reset();
    }

    reset() {
        this.active = false;
        this.frames = [];
        this.durationMs = 0;
        this.trailingSilenceMs = 0;
        this.sampleRate = 48000;
        this.channelCount = 1;
        this.lastLevel = 0;
        this.lastHasSpeech = false;
    }

    push(data) {
        const level = calculateRms(data.samples);
        const sampleRate = data.sampleRate || 48000;
        const channelCount = data.channelCount || 1;
        const durationMs = (data.samples.length / channelCount / sampleRate) * 1000;
        const hasSpeech = level >= this.threshold;

        this.lastLevel = level;
        this.lastHasSpeech = hasSpeech;

        if (!this.active && !hasSpeech) {
            return null;
        }

        if (!this.active) {
            this.active = true;
            this.sampleRate = sampleRate;
            this.channelCount = channelCount;
        }

        this.frames.push(int16ArrayToBuffer(data.samples));
        this.durationMs += durationMs;
        this.trailingSilenceMs = hasSpeech
            ? 0
            : this.trailingSilenceMs + durationMs;

        if (
            this.durationMs >= this.minSpeechMs &&
            (this.trailingSilenceMs >= this.silenceMs ||
                this.durationMs >= this.maxTurnMs)
        ) {
            return this.flush();
        }

        return null;
    }

    flush() {
        if (!this.active || this.durationMs < this.minSpeechMs || !this.frames.length) {
            this.reset();
            return null;
        }

        const turn = {
            pcm: Buffer.concat(this.frames),
            durationMs: Math.round(this.durationMs),
            sampleRate: this.sampleRate,
            channelCount: this.channelCount,
        };

        this.reset();

        return turn;
    }
}

function calculateRms(samples) {
    if (!samples.length) {
        return 0;
    }

    let sumSquares = 0;

    for (let index = 0; index < samples.length; index += 1) {
        const normalized = samples[index] / 32768;
        sumSquares += normalized * normalized;
    }

    return Math.sqrt(sumSquares / samples.length);
}

module.exports = CallVad;
