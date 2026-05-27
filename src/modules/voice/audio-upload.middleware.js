const fs = require("fs");
const path = require("path");
const express = require("express");
const multer = require("multer");

const env = require("../../config/env");
const {
    INPUT_AUDIO_EXTENSIONS,
    INPUT_AUDIO_MIME_TYPES,
} = require("./audio.constants");

fs.mkdirSync(env.audioUploadDir, { recursive: true });

function getExtension(file) {
    const extension = path
        .extname(file.originalname || "")
        .replace(".", "")
        .toLowerCase();

    return extension || "wav";
}

const storage = multer.diskStorage({
    destination(req, file, cb) {
        cb(null, env.audioUploadDir);
    },
    filename(req, file, cb) {
        cb(null, `${Date.now()}-${cryptoRandomId()}.${getExtension(file)}`);
    },
});

function cryptoRandomId() {
    return require("crypto").randomUUID();
}

function fileFilter(req, file, cb) {
    const extension = getExtension(file);
    const mimetype = (file.mimetype || "").toLowerCase();
    const isAllowed =
        INPUT_AUDIO_EXTENSIONS.includes(extension) ||
        INPUT_AUDIO_MIME_TYPES.includes(mimetype);

    if (!isAllowed) {
        const error = new Error(
            `Unsupported audio file. Allowed extensions: ${INPUT_AUDIO_EXTENSIONS.join(", ")}`
        );
        error.status = 415;
        return cb(error);
    }

    return cb(null, true);
}

const uploadAudio = multer({
    storage,
    fileFilter,
    limits: {
        fileSize: env.maxAudioUploadMb * 1024 * 1024,
        files: 1,
    },
});

function isRawAudioRequest(req) {
    const contentType = String(req.headers["content-type"] || "").toLowerCase();

    return (
        contentType.startsWith("audio/") ||
        contentType.startsWith("video/") ||
        contentType.startsWith("application/octet-stream")
    );
}

function parseSttAudio(req, res, next) {
    const contentType = String(req.headers["content-type"] || "").toLowerCase();

    if (contentType.startsWith("multipart/form-data")) {
        return uploadAudio.single("audio")(req, res, next);
    }

    if (isRawAudioRequest(req)) {
        return express.raw({
            type: () => true,
            limit: `${env.maxAudioUploadMb}mb`,
        })(req, res, next);
    }

    return next();
}

module.exports = {
    parseSttAudio,
    uploadAudio,
};
