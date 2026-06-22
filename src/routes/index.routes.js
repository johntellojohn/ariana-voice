const express = require("express");

const healthController = require("../controllers/health.controller");
const voiceRoutes = require("../modules/voice/voice.routes");
const pbxRoutes = require("../modules/pbx/pbx.routes");

const router = express.Router();

router.get("/", healthController.index);
router.get("/health", healthController.health);

router.use("/voice", voiceRoutes);
router.use("/pbx", pbxRoutes);

module.exports = router;
