const express = require("express");
const callsController = require("./calls.controller");

const router = express.Router();

router.post("/session", callsController.createSession);
router.post("/outbound-session", callsController.createOutboundSession);
router.get("/sessions", callsController.listSessions);
router.get("/:session_id", callsController.showSession);
router.post("/:session_id/answer", callsController.applySessionAnswer);
router.post("/:session_id/agent", callsController.connectAgent);
router.post("/:session_id/close", callsController.closeSession);

module.exports = router;
