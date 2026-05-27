const sttService = require("../stt/stt.service");
const ttsService = require("../tts/tts.service");
const laravelService = require("../laravel/laravel.service");
const env = require("../../config/env");
const {
    INPUT_AUDIO_EXTENSIONS,
    STT_MODELS,
    TTS_FORMATS,
    TTS_MODELS,
    TTS_VOICES,
} = require("./audio.constants");

function getBaseUrl(req) {
    if (env.publicBaseUrl) {
        return env.publicBaseUrl;
    }

    return `${req.protocol}://${req.get("host")}`;
}

async function processTurn(req, res, next) {
    try {
        const { call_id, from, text, tenant } = req.body;

        if (!call_id || !text) {
            return res.status(422).json({
                ok: false,
                message: "call_id and text are required",
            });
        }

        const laravelResponse = await laravelService.sendVoiceTurn({
            call_id,
            from,
            text,
            tenant,
        });

        res.json({
            ok: true,
            data: laravelResponse,
        });
    } catch (error) {
        next(error);
    }
}

async function speechToText(req, res, next) {
    try {
        const rawAudio = Buffer.isBuffer(req.body)
            ? {
                  buffer: req.body,
                  contentType: req.get("content-type"),
                  filename: req.get("x-audio-filename"),
              }
            : null;
        const body = rawAudio ? req.query : req.body;
        const result = await sttService.transcribe({
            file: req.file,
            rawAudio,
            body,
        });

        res.json({
            ok: true,
            data: result,
        });
    } catch (error) {
        next(error);
    }
}

async function textToSpeech(req, res, next) {
    try {
        const result = await ttsService.synthesize(req.body, {
            baseUrl: getBaseUrl(req),
        });

        res.json({
            ok: true,
            data: result,
        });
    } catch (error) {
        next(error);
    }
}

function options(req, res) {
    res.json({
        ok: true,
        data: {
            input_audio_extensions: INPUT_AUDIO_EXTENSIONS,
            max_audio_upload_mb: env.maxAudioUploadMb,
            stt_models: STT_MODELS,
            default_stt_model: env.openaiSttModel,
            tts_models: TTS_MODELS,
            default_tts_model: env.openaiTtsModel,
            tts_voices: TTS_VOICES,
            default_tts_voice: env.openaiTtsVoice,
            tts_formats: TTS_FORMATS,
        },
    });
}

module.exports = {
    processTurn,
    speechToText,
    textToSpeech,
    options,
};
