const assert = require("assert");

const RealtimeCallSession = require("../src/modules/calls/realtime-call-session");

async function testInitialGreetingUsesExactText() {
    const session = new RealtimeCallSession(
        {
            call_id: "call-test",
            initial_greeting: "Hola soy Ariana, tu asistente puedo ayudar a agendar.",
            realtime: {},
        },
        {
            sessionId: "session-test",
        }
    );
    const events = [];

    session.realtimeReady = true;
    session.audioOutput = {};
    session.pc = {
        connectionState: "connected",
        iceConnectionState: "completed",
    };
    session.sendRealtimeEvent = (event) => events.push(event);

    const played = await session.playInitialGreeting("test");

    assert.strictEqual(played, true);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, "response.create");
    assert.deepStrictEqual(events[0].response.output_modalities, ["audio"]);
    assert.match(events[0].response.instructions, /Di exactamente este saludo/);
    assert.match(events[0].response.instructions, /Hola soy Ariana/);
    assert.doesNotMatch(events[0].response.instructions, /si encaja/);
}

async function testNotificationInitialGreetingUsesExactTtsPlayback() {
    const session = new RealtimeCallSession(
        {
            call_id: "call-notification",
            initial_greeting: "Hola Lizeth Guerra recuerda que debes llegar a la oficina.",
            notification_only: true,
            realtime: {},
        },
        {
            sessionId: "session-notification",
        }
    );
    const events = [];
    const playedUrls = [];

    session.realtimeReady = true;
    session.audioOutput = {};
    session.pc = {
        connectionState: "connected",
        iceConnectionState: "completed",
    };
    session.sendRealtimeEvent = (event) => events.push(event);
    session.playNotificationGreetingAudio = async (text, reason) => {
        playedUrls.push({ text, reason });
        return true;
    };

    const played = await session.playInitialGreeting("test_notification");

    assert.strictEqual(played, true);
    assert.deepStrictEqual(events, []);
    assert.deepStrictEqual(playedUrls, [
        {
            text: "Hola Lizeth Guerra recuerda que debes llegar a la oficina.",
            reason: "test_notification",
        },
    ]);
    assert.strictEqual(session.initialGreetingPlayed, true);
}

async function testNotificationModeDoesNotStreamInboundAudioToRealtime() {
    const session = new RealtimeCallSession(
        {
            call_id: "call-notification-input",
            initial_greeting: "Hola, este mensaje solo debe leerse y colgar.",
            notification_only: true,
            realtime: {},
        },
        {
            sessionId: "session-notification-input",
        }
    );
    const events = [];

    session.realtimeReady = true;
    session.sendRealtimeEvent = (event) => events.push(event);

    session.handleAudioData({
        samples: new Int16Array([1200, 1300, 900, 1000]),
        sampleRate: 48000,
        channelCount: 1,
    });

    assert.deepStrictEqual(events, []);

    const config = session.sessionConfig();
    assert.strictEqual(config.audio.input.turn_detection.create_response, false);
    assert.strictEqual(config.audio.input.turn_detection.interrupt_response, false);
    assert.deepStrictEqual(config.tools, []);
    assert.strictEqual(config.tool_choice, "none");
}

async function testNotificationModeIgnoresRealtimeAudioDeltas() {
    const session = new RealtimeCallSession(
        {
            call_id: "call-notification-delta",
            notification_only: true,
            realtime: {},
        },
        {
            sessionId: "session-notification-delta",
        }
    );
    let queued = 0;

    session.audioOutput = {
        enqueuePcm: async () => {
            queued += 1;
        },
    };

    session.handleRealtimeEvent({
        type: "response.output_audio.delta",
        delta: Buffer.from([0, 0, 1, 0]).toString("base64"),
    });

    assert.strictEqual(queued, 0);
}

async function testInitialGreetingWaitsForIceBeforeRequestingAudio() {
    const session = new RealtimeCallSession(
        {
            call_id: "call-wait-ice",
            initial_greeting: "Hola, este mensaje debe escucharse completo.",
            realtime: {},
        },
        {
            sessionId: "session-wait-ice",
        }
    );
    const events = [];

    session.realtimeReady = true;
    session.audioOutput = {};
    session.pc = {
        connectionState: "connecting",
        iceConnectionState: "checking",
    };
    session.waitForPlaybackReady = async () => false;
    session.sendRealtimeEvent = (event) => events.push(event);

    const played = await session.playInitialGreeting("test_wait_ice");

    assert.strictEqual(played, false);
    assert.strictEqual(events.length, 0);
    assert.strictEqual(session.initialGreetingPlaybackStarted, false);
    assert.strictEqual(session.initialGreetingPlayed, false);
}

(async () => {
    await testInitialGreetingUsesExactText();
    await testNotificationInitialGreetingUsesExactTtsPlayback();
    await testNotificationModeDoesNotStreamInboundAudioToRealtime();
    await testNotificationModeIgnoresRealtimeAudioDeltas();
    await testInitialGreetingWaitsForIceBeforeRequestingAudio();
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
