const express = require("express");

const pbxController = require("./pbx.controller");
const requireVoiceApiToken = require("../voice/voice-auth.middleware");

const router = express.Router();

router.use(requireVoiceApiToken);

router.get("/health", pbxController.health);
router.get("/events", pbxController.callEvents);
router.get("/calls", pbxController.callsSummary);
router.get("/calls/:linkedid", pbxController.showCall);
router.post("/calls/:linkedid/hangup", pbxController.hangupCall);
router.post("/originate/extension", pbxController.originateExtension);
router.post("/originate/external", pbxController.originateExternal);
router.post("/originate/direct", pbxController.originateDirect);

module.exports = router;
