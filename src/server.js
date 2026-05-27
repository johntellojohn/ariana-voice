const app = require("./app");
const env = require("./config/env");

const server = app.listen(env.port, () => {
    console.log(`${env.appName} running on port ${env.port}`);
});

process.on("SIGTERM", () => {
    console.log("SIGTERM received. Closing server...");
    server.close(() => {
        console.log("Server closed.");
        process.exit(0);
    });
});

process.on("SIGINT", () => {
    console.log("SIGINT received. Closing server...");
    server.close(() => {
        console.log("Server closed.");
        process.exit(0);
    });
});