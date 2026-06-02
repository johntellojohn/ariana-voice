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
    openaiRealtimeModel: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime",
    openaiRealtimeVoice: process.env.OPENAI_REALTIME_VOICE || "marin",
    realtimeTranscriptionModel:
        process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe",
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

    webrtcIceServers: parseJson(process.env.WEBRTC_ICE_SERVERS, []),
    webrtcIceGatherTimeoutMs: toNumber(process.env.WEBRTC_ICE_GATHER_TIMEOUT_MS, 3000),
    callAudioLanguage: process.env.CALL_AUDIO_LANGUAGE || "es",
    callAllowLanguageOverride: toBoolean(process.env.CALL_ALLOW_LANGUAGE_OVERRIDE, false),
    callSttPrompt:
        process.env.CALL_STT_PROMPT ||
        "Transcribe audio de una llamada de WhatsApp en espanol latino. No traduzcas al ingles. Conserva palabras cortas comunes como hola, donde, vale, gracias, cita y agenda. Si el audio no es claro, devuelve la mejor transcripcion en espanol.",
    callSttTemperature: toNumber(process.env.CALL_STT_TEMPERATURE, 0),
    callCallbackTimeoutMs: toNumber(process.env.CALL_CALLBACK_TIMEOUT_MS, 30000),
    callTurnRmsThreshold: toNumber(process.env.CALL_TURN_RMS_THRESHOLD, 0.015),
    callTurnSilenceMs: toNumber(process.env.CALL_TURN_SILENCE_MS, 900),
    callTurnMinSpeechMs: toNumber(process.env.CALL_TURN_MIN_SPEECH_MS, 450),
    callTurnMaxMs: toNumber(process.env.CALL_TURN_MAX_MS, 15000),
    callSilenceFrameMs: toNumber(process.env.CALL_SILENCE_FRAME_MS, 10),
    callSilenceLogEveryFrames: toNumber(process.env.CALL_SILENCE_LOG_EVERY_FRAMES, 6000),
    callIdleTimeoutMs: toNumber(process.env.CALL_IDLE_TIMEOUT_MS, 60000),
    callMaxDurationMs: toNumber(process.env.CALL_MAX_DURATION_MS, 1800000),
    callPostPlaybackMuteMs: toNumber(process.env.CALL_POST_PLAYBACK_MUTE_MS, 800),
    callLogSdp: toBoolean(process.env.CALL_LOG_SDP, true),
    callPlaybackWaitForIceMs: toNumber(process.env.CALL_PLAYBACK_WAIT_FOR_ICE_MS, 5000),
    realtimeConnectTimeoutMs: toNumber(process.env.REALTIME_CONNECT_TIMEOUT_MS, 10000),
    realtimeToolTimeoutMs: toNumber(process.env.REALTIME_TOOL_TIMEOUT_MS, 12000),

    logLevel: process.env.LOG_LEVEL || "info",
};

module.exports = env;

function parseJson(value, fallback) {
    if (!value) {
        return fallback;
    }

    try {
        return JSON.parse(value);
    } catch (error) {
        console.warn(`Invalid JSON env value: ${error.message}`);
        return fallback;
    }
}
