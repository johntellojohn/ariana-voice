const app = require("./app");
const env = require("./config/env");
const { attachCallWebSocketServer } = require("./modules/calls/calls.websocket");
const pbxService = require("./modules/pbx/pbx.service");

const server = app.listen(env.port, () => {
    console.log(`${env.appName} running on port ${env.port}`);
});

attachCallWebSocketServer(server);
pbxService.start();

process.on("SIGTERM", () => {
    console.log("SIGTERM received. Closing server...");
    pbxService.stop();
    server.close(() => {
        console.log("Server closed.");
        process.exit(0);
    });
});

process.on("SIGINT", () => {
    console.log("SIGINT received. Closing server...");
    pbxService.stop();
    server.close(() => {
        console.log("Server closed.");
        process.exit(0);
    });
});
