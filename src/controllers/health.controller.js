const env = require("../config/env");
const renderHealthPage = require("../views/health-page");

function index(req, res) {
    const payload = {
        ok: true,
        service: env.appName,
        environment: env.nodeEnv,
    };

    respond(req, res, payload);
}

function health(req, res) {
    const payload = {
        ok: true,
        status: "healthy",
        timestamp: new Date().toISOString(),
        service: env.appName,
        environment: env.nodeEnv,
    };

    respond(req, res, payload);
}

module.exports = {
    index,
    health,
};

function respond(req, res, payload) {
    if (!wantsHtml(req)) {
        return res.json(payload);
    }

    return res.type("html").send(renderHealthPage({
        ok: payload.ok,
        title: "Ariana Voice",
        subtitle: "WhatsApp, WebRTC, STT y TTS en linea.",
        service: payload.service || env.appName,
        environment: payload.environment || env.nodeEnv,
        module: "Voice Gateway",
        timestamp: payload.timestamp || new Date().toISOString(),
        endpoint: req.originalUrl,
    }));
}

function wantsHtml(req) {
    return String(req.get("accept") || "").includes("text/html");
}
