const env = require("../config/env");

function errorMiddleware(err, req, res, next) {
    console.error(err);

    const status = err.status || err.statusCode || statusFromCode(err.code) || 500;
    const message =
        status === 500 && env.nodeEnv === "production"
            ? "Internal server error"
            : err.message || "Internal server error";

    res.status(status).json({
        ok: false,
        message,
    });
}

function statusFromCode(code) {
    if (code === "LIMIT_FILE_SIZE") {
        return 413;
    }

    if (code && code.startsWith("LIMIT_")) {
        return 422;
    }

    return null;
}

module.exports = errorMiddleware;
