const express = require("express");
const voiceController = require("./voice.controller");
const { parseSttAudio } = require("./audio-upload.middleware");
const requireVoiceApiToken = require("./voice-auth.middleware");
const callsRoutes = require("../calls/calls.routes");

const router = express.Router();

router.use(requireVoiceApiToken);

router.get("/options", voiceController.options);
router.use("/calls", callsRoutes);
router.post("/turn", voiceController.processTurn);
router.post("/stt", parseSttAudio, voiceController.speechToText);
router.post("/tts", voiceController.textToSpeech);

module.exports = router;
