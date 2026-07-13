const REALTIME_TO_TTS_VOICE_MAP = {
    marin: "nova",
};

const TTS_HTTP_VOICES = new Set([
    "alloy",
    "ash",
    "ballad",
    "coral",
    "echo",
    "fable",
    "nova",
    "onyx",
    "sage",
    "shimmer",
    "verse",
    "cedar",
]);

function normalizeTtsConfig(value = {}) {
    if (!value || typeof value !== "object") {
        return {};
    }

    const config = {};
    const model = stringValue(value.model);
    const voice = stringValue(value.voice);
    const format = stringValue(value.format);
    const instructions = stringValue(value.instructions);
    const speed = speedValue(value.speed);

    if (model) {
        config.model = model;
    }

    if (voice) {
        config.voice = toTtsVoice(voice);
    }

    if (format) {
        config.format = format;
    }

    if (instructions) {
        config.instructions = instructions;
    }

    if (speed !== undefined) {
        config.speed = speed;
    }

    return config;
}

function toTtsVoice(voice, fallback = "nova") {
    const selected = stringValue(voice);

    if (TTS_HTTP_VOICES.has(selected)) {
        return selected;
    }

    return REALTIME_TO_TTS_VOICE_MAP[selected] || fallback;
}

function stringValue(value) {
    if (value === undefined || value === null) {
        return "";
    }

    return String(value).trim();
}

function speedValue(value) {
    if (value === undefined || value === null || value === "") {
        return undefined;
    }

    const speed = Number(value);

    if (!Number.isFinite(speed)) {
        return undefined;
    }

    return Math.min(4, Math.max(0.25, speed));
}

module.exports = {
    normalizeTtsConfig,
    toTtsVoice,
};
