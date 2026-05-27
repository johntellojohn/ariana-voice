const INPUT_AUDIO_EXTENSIONS = ["flac", "mp3", "mp4", "mpeg", "mpga", "m4a", "ogg", "wav", "webm"];

const INPUT_AUDIO_MIME_TYPES = [
    "audio/aac",
    "audio/flac",
    "audio/m4a",
    "audio/mp3",
    "audio/mp4",
    "audio/mpeg",
    "audio/mpga",
    "audio/ogg",
    "audio/wav",
    "audio/wave",
    "audio/webm",
    "audio/x-m4a",
    "audio/x-wav",
    "video/mp4",
    "video/mpeg",
    "video/webm",
];

const TTS_FORMATS = ["mp3", "opus", "aac", "flac", "wav", "pcm"];

const TTS_MIME_TYPES = {
    mp3: "audio/mpeg",
    opus: "audio/opus",
    aac: "audio/aac",
    flac: "audio/flac",
    wav: "audio/wav",
    pcm: "audio/L16",
};

const TTS_MODELS = ["gpt-4o-mini-tts", "gpt-4o-mini-tts-2025-12-15", "tts-1", "tts-1-hd"];

const TTS_VOICES = [
    "alloy",
    "ash",
    "ballad",
    "coral",
    "echo",
    "fable",
    "marin",
    "nova",
    "onyx",
    "sage",
    "shimmer",
    "verse",
    "cedar",
];

const STT_MODELS = [
    "gpt-4o-mini-transcribe",
    "gpt-4o-mini-transcribe-2025-12-15",
    "gpt-4o-transcribe",
    "gpt-4o-transcribe-diarize",
    "whisper-1",
];

module.exports = {
    INPUT_AUDIO_EXTENSIONS,
    INPUT_AUDIO_MIME_TYPES,
    TTS_FORMATS,
    TTS_MIME_TYPES,
    TTS_MODELS,
    TTS_VOICES,
    STT_MODELS,
};
