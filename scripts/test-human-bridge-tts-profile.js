const assert = require("assert");

const HumanBridgeCallSession = require("../src/modules/calls/human-bridge-call-session");
const ttsService = require("../src/modules/tts/tts.service");

async function testWaitMessageUsesConfiguredTtsProfile() {
    const originalSynthesize = ttsService.synthesize;
    const synthesizeCalls = [];
    const playbackCalls = [];

    ttsService.synthesize = async (body, options) => {
        synthesizeCalls.push({ body, options });

        return {
            audio_url: "http://localhost/wait.mp3",
        };
    };

    try {
        const session = new HumanBridgeCallSession({
            call_id: "call-wait-profile",
            phone_number_id: "phone-1",
            offer_sdp: "v=0\r\n",
            wait_message: "Gracias por esperar.",
            tts: {
                model: "gpt-4o-mini-tts",
                voice: "coral",
                speed: 1.4,
                instructions: "Lee con voz tranquila y profesional.",
            },
        }, {
            sessionId: "session-wait-profile",
            baseUrl: "http://localhost",
        });

        session.metaAudioOutput = {
            enqueueAudioUrl: async (audioUrl, metadata) => {
                playbackCalls.push({ audioUrl, metadata });

                return {
                    framesSent: 1,
                    framesQueued: 1,
                    pcmBytes: 960,
                    bytesDownloaded: 128,
                    stopped: false,
                };
            },
        };

        await session.playWaitMessage("unit_test");

        assert.strictEqual(synthesizeCalls.length, 1);
        assert.strictEqual(synthesizeCalls[0].body.text, "Gracias por esperar.");
        assert.strictEqual(synthesizeCalls[0].body.model, "gpt-4o-mini-tts");
        assert.strictEqual(synthesizeCalls[0].body.voice, "coral");
        assert.strictEqual(synthesizeCalls[0].body.speed, 1.4);
        assert.strictEqual(synthesizeCalls[0].body.instructions, "Lee con voz tranquila y profesional.");
        assert.strictEqual(playbackCalls.length, 1);
        assert.strictEqual(playbackCalls[0].metadata.source, "human_bridge_wait_message");
    } finally {
        ttsService.synthesize = originalSynthesize;
    }
}

(async () => {
    await testWaitMessageUsesConfiguredTtsProfile();
    console.log("human bridge tts profile tests passed");
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
