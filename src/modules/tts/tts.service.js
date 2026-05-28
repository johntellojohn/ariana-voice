const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

const env = require("../../config/env");
const { getOpenAIClient } = require("../openai/openai.client");
const {
    TTS_FORMATS,
    TTS_MIME_TYPES,
    TTS_MODELS,
    TTS_VOICES,
} = require("../voice/audio.constants");

fs.mkdirSync(env.ttsOutputDir, { recursive: true });

function httpError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function toBoolean(value) {
    return value === true || value === "true" || value === "1" || value === 1;
}

function normalizeText(text) {
    const normalized = String(text || "").trim();

    if (!normalized) {
        throw httpError(422, "text is required");
    }

    if (normalized.length > 4096) {
        throw httpError(422, "text must be 4096 characters or fewer");
    }

    return normalized;
}

function normalizeModel(model) {
    const selectedModel = model || env.openaiTtsModel;

    if (!TTS_MODELS.includes(selectedModel)) {
        throw httpError(
            422,
            `Unsupported TTS model. Allowed models: ${TTS_MODELS.join(", ")}`
        );
    }

    return selectedModel;
}

function normalizeVoice(voice) {
    const selectedVoice = voice || env.openaiTtsVoice;

    if (!TTS_VOICES.includes(selectedVoice)) {
        throw httpError(
            422,
            `Unsupported TTS voice. Allowed voices: ${TTS_VOICES.join(", ")}`
        );
    }

    return selectedVoice;
}

function normalizeFormat(format) {
    const selectedFormat = String(format || "mp3").toLowerCase();

    if (!TTS_FORMATS.includes(selectedFormat)) {
        throw httpError(
            422,
            `Unsupported audio format. Allowed formats: ${TTS_FORMATS.join(", ")}`
        );
    }

    return selectedFormat;
}

function normalizeSpeed(speed) {
    if (speed === undefined || speed === null || speed === "") {
        return undefined;
    }

    const parsed = Number(speed);

    if (!Number.isFinite(parsed) || parsed < 0.25 || parsed > 4) {
        throw httpError(422, "speed must be a number between 0.25 and 4");
    }

    return parsed;
}

function buildAudioUrl(baseUrl, relativeUrl) {
    if (!baseUrl) {
        return relativeUrl;
    }

    return `${baseUrl.replace(/\/$/, "")}${relativeUrl}`;
}

function runFfmpeg(args) {
    return new Promise((resolve, reject) => {
        execFile("ffmpeg", args, (error, stdout, stderr) => {
            if (error) {
                error.message = `${error.message}: ${stderr || stdout}`;
                return reject(error);
            }

            return resolve();
        });
    });
}

async function normalizeMp3(filePath) {
    if (!env.normalizeMp3WithFfmpeg) {
        return false;
    }

    const normalizedPath = `${filePath}.normalized.mp3`;

    try {
        await runFfmpeg([
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            filePath,
            "-map",
            "0:a:0",
            "-codec:a",
            "libmp3lame",
            "-b:a",
            "128k",
            "-ar",
            "44100",
            "-ac",
            "1",
            "-write_xing",
            "1",
            normalizedPath,
        ]);

        await fsp.rename(normalizedPath, filePath);
        return true;
    } catch (error) {
        await fsp.unlink(normalizedPath).catch(() => {});
        console.error("MP3 normalization failed", error);
        return false;
    }
}

async function synthesize(payload, options = {}) {
    const text = normalizeText(payload.text);
    const model = normalizeModel(payload.model);
    const voice = normalizeVoice(payload.voice);
    const format = normalizeFormat(payload.format || payload.response_format);
    const speed = normalizeSpeed(payload.speed);
    const instructions = payload.instructions
        ? String(payload.instructions).trim()
        : "";
    const client = getOpenAIClient();
    const request = {
        model,
        voice,
        input: text,
        response_format: format,
    };

    if (speed !== undefined) {
        request.speed = speed;
    }

    if (instructions && !["tts-1", "tts-1-hd"].includes(model)) {
        request.instructions = instructions;
    }

    const response = await client.audio.speech.create(request);
    let buffer = Buffer.from(await response.arrayBuffer());
    const filename = `${Date.now()}-${crypto.randomUUID()}.${format}`;
    const filePath = path.join(env.ttsOutputDir, filename);
    const relativeUrl = `/api/audio/${filename}`;
    const mimeType = TTS_MIME_TYPES[format] || "application/octet-stream";

    await fsp.writeFile(filePath, buffer);

    const normalized = format === "mp3" ? await normalizeMp3(filePath) : false;

    if (normalized) {
        buffer = await fsp.readFile(filePath);
    }

    const result = {
        provider: "openai",
        model,
        voice,
        format,
        mime_type: mimeType,
        size_bytes: buffer.length,
        filename,
        audio_url: buildAudioUrl(options.baseUrl, relativeUrl),
        relative_url: relativeUrl,
        ai_generated: true,
        normalized,
    };

    if (toBoolean(payload.return_audio_base64)) {
        result.audio_base64 = buffer.toString("base64");
    }

    return result;
}

module.exports = {
    synthesize,
};
