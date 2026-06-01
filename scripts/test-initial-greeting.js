const assert = require("assert");

const CallSession = require("../src/modules/calls/call-session");
const ttsService = require("../src/modules/tts/tts.service");

async function testInitialGreetingPlaysOnlyOnce() {
    const originalSynthesize = ttsService.synthesize;
    const calls = {
        synthesize: [],
        playback: [],
        callback: [],
    };

    ttsService.synthesize = async (body, options) => {
        calls.synthesize.push({ body, options });
        return {
            audio_url: "http://localhost/greeting.mp3",
        };
    };

    try {
        const session = new CallSession({
            call_id: "call-1",
            phone_number_id: "phone-1",
            offer_sdp: "v=0\r\n",
            initial_greeting: " Hola, gracias por llamar. ",
        }, {
            sessionId: "session-1",
            baseUrl: "http://localhost",
        });

        session.pc = {
            connectionState: "connected",
            iceConnectionState: "connected",
        };
        session.audioOutput = {};
        session.playAudioUrl = async (audioUrl, source) => {
            calls.playback.push({ audioUrl, source });
        };
        session.sendCallback = async (payload) => {
            calls.callback.push(payload);
        };

        await session.playInitialGreeting("unit_test");
        await session.playInitialGreeting("unit_test_again");

        assert.strictEqual(calls.synthesize.length, 1);
        assert.strictEqual(calls.synthesize[0].body.text, "Hola, gracias por llamar.");
        assert.strictEqual(calls.synthesize[0].body.format, "mp3");
        assert.strictEqual(calls.playback.length, 1);
        assert.deepStrictEqual(calls.playback[0], {
            audioUrl: "http://localhost/greeting.mp3",
            source: "initial_greeting",
        });
        assert.strictEqual(calls.callback.length, 0);
        assert.strictEqual(session.initialGreetingPending, false);
        assert.strictEqual(session.initialGreetingPlayed, true);
    } finally {
        ttsService.synthesize = originalSynthesize;
    }
}

async function testInitialGreetingFailureDoesNotThrow() {
    const originalSynthesize = ttsService.synthesize;

    ttsService.synthesize = async () => {
        throw new Error("TTS unavailable");
    };

    try {
        const session = new CallSession({
            call_id: "call-2",
            phone_number_id: "phone-2",
            offer_sdp: "v=0\r\n",
            initial_greeting: "Hola",
        }, {
            sessionId: "session-2",
            baseUrl: "http://localhost",
        });

        session.pc = {
            connectionState: "connected",
            iceConnectionState: "connected",
        };
        session.audioOutput = {};
        session.playAudioUrl = async () => {
            throw new Error("Playback should not be called");
        };

        await session.playInitialGreeting("unit_test");

        assert.strictEqual(session.initialGreetingPending, false);
        assert.strictEqual(session.initialGreetingPlayed, false);
    } finally {
        ttsService.synthesize = originalSynthesize;
    }
}

(async () => {
    await testInitialGreetingPlaysOnlyOnce();
    await testInitialGreetingFailureDoesNotThrow();
    console.log("initial greeting tests passed");
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
