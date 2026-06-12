const assert = require("assert");

const OutboundRealtimeCallSession = require("../src/modules/calls/outbound-realtime-call-session");

async function testOutboundAnswerTriggersInitialGreeting() {
    const session = new OutboundRealtimeCallSession(
        {
            call_id: "call-outbound-1",
            phone_number_id: "phone-1",
            initial_greeting: "Hola, te llamo para confirmar tu cita.",
            realtime: {},
        },
        {
            sessionId: "session-outbound-1",
        }
    );
    const calls = [];

    session.pc = {
        remoteDescription: null,
        currentRemoteDescription: null,
        setRemoteDescription: async (description) => {
            session.pc.remoteDescription = description;
        },
    };
    session.playInitialGreeting = async (reason) => {
        calls.push(reason);
        return true;
    };

    const snapshot = await session.applyAnswer("v=0\r\nfake-answer");

    assert.strictEqual(snapshot.status, "answer_applied");
    assert.deepStrictEqual(calls, ["outbound_answer_applied"]);
}

async function testOutboundAnswerNormalizesEscapedLineBreaks() {
    const session = new OutboundRealtimeCallSession(
        {
            call_id: "call-outbound-2",
            phone_number_id: "phone-1",
            realtime: {},
        },
        {
            sessionId: "session-outbound-2",
        }
    );
    let appliedSdp = "";

    session.pc = {
        remoteDescription: null,
        currentRemoteDescription: null,
        setRemoteDescription: async (description) => {
            appliedSdp = description.sdp;
            session.pc.remoteDescription = description;
        },
    };
    session.playInitialGreeting = async () => false;

    await session.applyAnswer("v=0\\r\\no=- 1 2 IN IP4 127.0.0.1\\r\\ns=-\\r\\nt=0 0");

    assert.strictEqual(appliedSdp, "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n");
}

async function testNotificationAnswerWaitsForRemoteMediaBeforeGreeting() {
    const session = new OutboundRealtimeCallSession(
        {
            call_id: "call-outbound-notification-answer",
            phone_number_id: "phone-1",
            initial_greeting: "Hola, escucha este mensaje desde el inicio.",
            notification_only: true,
            hangup_after_initial_greeting: true,
            realtime: {},
        },
        {
            sessionId: "session-outbound-notification-answer",
        }
    );
    const calls = [];
    const events = [];

    session.realtimeReady = true;
    session.pc = {
        remoteDescription: null,
        currentRemoteDescription: null,
        setRemoteDescription: async (description) => {
            session.pc.remoteDescription = description;
        },
    };
    session.playInitialGreeting = async (reason) => {
        calls.push(reason);
        return true;
    };
    session.sendRealtimeEvent = (event) => events.push(event);

    await session.applyAnswer("v=0\r\nfake-answer");

    assert.deepStrictEqual(calls, []);

    session.handleAudioData({
        samples: new Int16Array([0, 0, 0, 0]),
        sampleRate: 48000,
        channelCount: 1,
    });

    assert.deepStrictEqual(calls, ["remote_audio_received"]);
    assert.deepStrictEqual(events, []);
}

async function testNotificationOutboundSkipsRealtimeTransport() {
    const session = new OutboundRealtimeCallSession(
        {
            call_id: "call-outbound-notification-no-realtime",
            phone_number_id: "phone-1",
            initial_greeting: "Hola, este es un mensaje de notificacion.",
            notification_only: true,
            hangup_after_initial_greeting: true,
            realtime: {},
        },
        {
            sessionId: "session-outbound-notification-no-realtime",
        }
    );
    let realtimeConnections = 0;

    session.connectRealtime = async () => {
        realtimeConnections++;
    };

    await session.prepareRealtimeTransportForOutbound();

    assert.strictEqual(realtimeConnections, 0);
    assert.strictEqual(session.realtimeReady, true);
}

async function testNotificationCloseWaitsForQueuedAudio() {
    const session = new OutboundRealtimeCallSession(
        {
            call_id: "call-outbound-notification",
            phone_number_id: "phone-1",
            initial_greeting: "Hola, recuerda llegar a las ocho.",
            notification_only: true,
            hangup_after_initial_greeting: true,
            realtime: {},
        },
        {
            sessionId: "session-outbound-notification",
        }
    );
    const closes = [];
    let pendingAudio = true;

    session.initialGreetingPlayed = true;
    session.audioOutput = {
        hasPendingAudio: () => pendingAudio,
    };
    session.close = async (reason) => {
        closes.push(reason);
    };

    session.handleRealtimeEvent({ type: "response.done" });
    await wait(900);

    assert.deepStrictEqual(closes, []);

    pendingAudio = false;
    await wait(150);

    assert.deepStrictEqual(closes, ["notification_initial_greeting_completed"]);
}

async function testNotificationTtsGreetingSchedulesCloseAfterPlayback() {
    const session = new OutboundRealtimeCallSession(
        {
            call_id: "call-outbound-notification-tts",
            phone_number_id: "phone-1",
            initial_greeting: "Hola Lizeth Guerra recuerda que debes llegar a la oficina.",
            notification_only: true,
            hangup_after_initial_greeting: true,
            realtime: {},
        },
        {
            sessionId: "session-outbound-notification-tts",
        }
    );
    const events = [];
    const closes = [];

    session.realtimeReady = true;
    session.remoteAudioFramesReceived = 1;
    session.audioOutput = {
        hasPendingAudio: () => false,
    };
    session.pc = {
        connectionState: "connected",
        iceConnectionState: "completed",
    };
    session.sendRealtimeEvent = (event) => events.push(event);
    session.playNotificationGreetingAudio = async () => true;
    session.close = async (reason) => {
        closes.push(reason);
    };

    const played = await session.playInitialGreeting("notification_tts_test");
    await wait(900);

    assert.strictEqual(played, true);
    assert.deepStrictEqual(events, []);
    assert.deepStrictEqual(closes, ["notification_initial_greeting_completed"]);
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
    await testOutboundAnswerTriggersInitialGreeting();
    await testOutboundAnswerNormalizesEscapedLineBreaks();
    await testNotificationAnswerWaitsForRemoteMediaBeforeGreeting();
    await testNotificationOutboundSkipsRealtimeTransport();
    await testNotificationCloseWaitsForQueuedAudio();
    await testNotificationTtsGreetingSchedulesCloseAfterPlayback();
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
