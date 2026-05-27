const express = require("express");

const healthController = require("../controllers/health.controller");
const voiceRoutes = require("../modules/voice/voice.routes");

const router = express.Router();

router.get("/", healthController.index);
router.get("/health", healthController.health);

router.use("/voice", voiceRoutes);

module.exports = router;