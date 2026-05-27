const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const env = require("../../config/env");
const { getOpenAIClient } = require("../openai/openai.client");
const {
    INPUT_AUDIO_EXTENSIONS,
    STT_MODELS,
} = require("../voice/audio.constants");

const MIME_EXTENSION_MAP = {
    "audio/flac": "flac",
    "audio/m4a": "m4a",
    "audio/mp3": "mp3",
    "audio/mp4": "mp4",
    "audio/mpeg": "mp3",
    "audio/mpga": "mpga",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "audio/wave": "wav",
    "audio/webm": "webm",
    "audio/x-m4a": "m4a",
    "audio/x-wav": "wav",
    "video/mp4": "mp4",
    "video/mpeg": "mpeg",
    "video/webm": "webm",
};

const EXTENSION_MIME_MAP = {
    flac: "audio/flac",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    mpeg: "video/mpeg",
    mpga: "audio/mpga",
    m4a: "audio/x-m4a",
    ogg: "audio/ogg",
    wav: "audio/wav",
    webm: "audio/webm",
};

fs.mkdirSync(env.audioUploadDir, { recursive: true });

function httpError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function normalizeModel(model) {
    const selectedModel = model || env.openaiSttModel;

    if (!STT_MODELS.includes(selectedModel)) {
        throw httpError(
            422,
            `Unsupported STT model. Allowed models: ${STT_MODELS.join(", ")}`
        );
    }

    return selectedModel;
}

function normalizeLanguage(language) {
    if (!language) {
        return undefined;
    }

    const normalized = String(language).trim().toLowerCase();

    if (!/^[a-z]{2}(-[a-z]{2})?$/.test(normalized)) {
        throw httpError(422, "language must be an ISO code like es or en");
    }

    return normalized;
}

function normalizeTemperature(temperature) {
    if (temperature === undefined || temperature === null || temperature === "") {
        return undefined;
    }

    const parsed = Number(temperature);

    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
        throw httpError(422, "temperature must be a number between 0 and 1");
    }

    return parsed;
}

function extensionFromBody(body) {
    const fileExtension = path
        .extname(body.filename || "")
        .replace(".", "")
        .toLowerCase();

    if (INPUT_AUDIO_EXTENSIONS.includes(fileExtension)) {
        return fileExtension;
    }

    const mimeExtension = MIME_EXTENSION_MAP[String(body.mime_type || "").toLowerCase()];

    if (mimeExtension) {
        return mimeExtension;
    }

    return "wav";
}

async function fileFromBase64(body) {
    if (!body.audio_base64) {
        return null;
    }

    let audioBase64 = String(body.audio_base64).trim();

    if (audioBase64.startsWith("data:")) {
        const commaIndex = audioBase64.indexOf(",");

        if (commaIndex === -1) {
            throw httpError(422, "audio_base64 data URL is invalid");
        }

        audioBase64 = audioBase64.slice(commaIndex + 1);
    }

    audioBase64 = audioBase64.replace(/\s/g, "");

    let buffer;

    try {
        buffer = Buffer.from(audioBase64, "base64");
    } catch (error) {
        throw httpError(422, "audio_base64 must be valid base64 audio");
    }

    if (!buffer.length) {
        throw httpError(422, "audio_base64 cannot be empty");
    }

    if (buffer.length > env.maxAudioUploadMb * 1024 * 1024) {
        throw httpError(413, `audio_base64 exceeds ${env.maxAudioUploadMb}MB`);
    }

    const extension = extensionFromBody(body);
    const filePath = path.join(
        env.audioUploadDir,
        `${Date.now()}-${crypto.randomUUID()}.${extension}`
    );

    await fsp.writeFile(filePath, buffer);

    return {
        path: filePath,
        originalname: body.filename || `audio.${extension}`,
        mimetype: body.mime_type || EXTENSION_MIME_MAP[extension] || "audio/wav",
        size: buffer.length,
    };
}

async function fileFromRawAudio(rawAudio) {
    if (!rawAudio || !Buffer.isBuffer(rawAudio.buffer)) {
        return null;
    }

    if (!rawAudio.buffer.length) {
        throw httpError(422, "audio body cannot be empty");
    }

    if (rawAudio.buffer.length > env.maxAudioUploadMb * 1024 * 1024) {
        throw httpError(413, `audio body exceeds ${env.maxAudioUploadMb}MB`);
    }

    const extension =
        MIME_EXTENSION_MAP[String(rawAudio.contentType || "").toLowerCase()] || "mp3";
    const filePath = path.join(
        env.audioUploadDir,
        `${Date.now()}-${crypto.randomUUID()}.${extension}`
    );

    await fsp.writeFile(filePath, rawAudio.buffer);

    return {
        path: filePath,
        originalname: rawAudio.filename || `audio.${extension}`,
        mimetype: rawAudio.contentType || EXTENSION_MIME_MAP[extension] || "audio/mpeg",
        size: rawAudio.buffer.length,
    };
}

async function removeFile(filePath) {
    if (!filePath) {
        return;
    }

    await fsp.unlink(filePath).catch(() => {});
}

async function transcribe({ file, rawAudio, body = {} }) {
    const audioFile = file || (await fileFromRawAudio(rawAudio)) || (await fileFromBase64(body));

    if (!audioFile) {
        throw httpError(
            422,
            "audio file is required. Send multipart/form-data field 'audio' or JSON field 'audio_base64'."
        );
    }

    try {
        const model = normalizeModel(body.model);
        const client = getOpenAIClient();
        const request = {
            file: fs.createReadStream(audioFile.path),
            model,
            response_format: "json",
        };
        const language = normalizeLanguage(body.language);
        const temperature = normalizeTemperature(body.temperature);
        const prompt = body.prompt ? String(body.prompt).trim() : "";

        if (language) {
            request.language = language;
        }

        if (temperature !== undefined) {
            request.temperature = temperature;
        }

        if (prompt && model !== "gpt-4o-transcribe-diarize") {
            request.prompt = prompt;
        }

        const response = await client.audio.transcriptions.create(request);

        return {
            provider: "openai",
            model,
            text: response.text || "",
            usage: response.usage || null,
            audio: {
                filename: audioFile.originalname,
                mime_type: audioFile.mimetype,
                size_bytes: audioFile.size,
            },
        };
    } finally {
        await removeFile(audioFile.path);
    }
}

module.exports = {
    transcribe,
};
