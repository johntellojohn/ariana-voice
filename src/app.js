const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const morgan = require("morgan");

const env = require("./config/env");
const routes = require("./routes/index.routes");
const errorMiddleware = require("./middlewares/error.middleware");

const app = express();

fs.mkdirSync(env.ttsOutputDir, { recursive: true });

app.set("trust proxy", 1);
app.use(helmet());
app.use(cors(buildCorsOptions()));
app.use(compression());

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.use(morgan("dev"));

app.use(
    "/api/audio",
    express.static(path.resolve(env.ttsOutputDir), {
        fallthrough: false,
        setHeaders(res) {
            res.setHeader("X-Content-Type-Options", "nosniff");
            res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("Content-Disposition", "inline");
            res.setHeader("Cache-Control", "no-store");
        },
    })
);

app.use("/api", routes);

app.use((req, res) => {
    res.status(404).json({
        ok: false,
        message: "Route not found",
    });
});

app.use(errorMiddleware);

function buildCorsOptions() {
    if (env.corsOrigins.includes("*")) {
        return {};
    }

    return {
        origin(origin, callback) {
            if (!origin || env.corsOrigins.includes(origin)) {
                return callback(null, true);
            }

            return callback(new Error("Origin not allowed by CORS"));
        },
    };
}

module.exports = app;
