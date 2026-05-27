const crypto = require("crypto");
const env = require("../../config/env");

function extractBearerToken(req) {
    const authorization = req.get("authorization") || "";

    if (authorization.toLowerCase().startsWith("bearer ")) {
        return authorization.slice(7).trim();
    }

    return req.get("x-voice-api-token") || "";
}

function tokensMatch(received, expected) {
    const receivedBuffer = Buffer.from(received);
    const expectedBuffer = Buffer.from(expected);

    return (
        receivedBuffer.length === expectedBuffer.length &&
        crypto.timingSafeEqual(receivedBuffer, expectedBuffer)
    );
}

function requireVoiceApiToken(req, res, next) {
    if (!env.voiceApiToken) {
        return next();
    }

    const token = extractBearerToken(req);

    if (!token || !tokensMatch(token, env.voiceApiToken)) {
        return res.status(401).json({
            ok: false,
            message: "Invalid or missing voice API token",
        });
    }

    return next();
}

module.exports = requireVoiceApiToken;
