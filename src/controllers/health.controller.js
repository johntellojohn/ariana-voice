const env = require("../config/env");

function index(req, res) {
    res.json({
        ok: true,
        service: env.appName,
        environment: env.nodeEnv,
    });
}

function health(req, res) {
    res.json({
        ok: true,
        status: "healthy",
        timestamp: new Date().toISOString(),
    });
}

module.exports = {
    index,
    health,
};