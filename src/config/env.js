require("dotenv").config();

const path = require("path");

function toNumber(value, fallback) {
    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : fallback;
}

function toList(value, fallback = []) {
    if (!value) {
        return fallback;
    }

    return value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}

function toBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === "") {
        return fallback;
    }

    return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

const env = {
    nodeEnv: process.env.NODE_ENV || "development",
    port: toNumber(process.env.PORT, 3001),
    appName: process.env.APP_NAME || "Ariana Voice Gateway",

    laravelApiUrl: process.env.LARAVEL_API_URL || "http://localhost",
    laravelApiToken: process.env.LARAVEL_API_TOKEN || "",

    openaiApiKey: process.env.OPENAI_API_KEY || "",
    openaiSttModel: process.env.OPENAI_STT_MODEL || "gpt-4o-mini-transcribe",
    openaiTtsModel: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
    openaiTtsVoice: process.env.OPENAI_TTS_VOICE || "marin",
    normalizeMp3WithFfmpeg: toBoolean(process.env.NORMALIZE_MP3_WITH_FFMPEG, true),

    voiceApiToken: process.env.VOICE_API_TOKEN || "",
    corsOrigins: toList(process.env.CORS_ORIGINS, ["*"]),
    publicBaseUrl: process.env.PUBLIC_BASE_URL || "",

    maxAudioUploadMb: toNumber(process.env.MAX_AUDIO_UPLOAD_MB, 25),
    tmpDir: process.env.TMP_DIR || path.join(process.cwd(), "tmp"),
    audioUploadDir:
        process.env.AUDIO_UPLOAD_DIR || path.join(process.cwd(), "tmp", "uploads"),
    ttsOutputDir:
        process.env.TTS_OUTPUT_DIR || path.join(process.cwd(), "tmp", "tts"),

    logLevel: process.env.LOG_LEVEL || "info",
};

module.exports = env;
