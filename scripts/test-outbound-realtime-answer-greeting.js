const assert = require("assert");

const OutboundRealtimeCallSession = require("../src/modules/calls/outbound-realtime-call-session");
const ttsService = require("../src/modules/tts/tts.service");

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
        session.initialGreetingPlayed = true;
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

async function testNotificationAnswerTriggersGreetingWithoutRealtimeEvent() {
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

    assert.deepStrictEqual(calls, ["outbound_answer_applied"]);
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
    let notificationPreloads = 0;

    session.connectRealtime = async () => {
        realtimeConnections++;
    };
    session.prepareNotificationGreetingAudio = async (text, reason) => {
        notificationPreloads++;
        assert.strictEqual(text, "Hola, este es un mensaje de notificacion.");
        assert.strictEqual(reason, "outbound_preload");
    };

    await session.prepareRealtimeTransportForOutbound();

    assert.strictEqual(realtimeConnections, 0);
    assert.strictEqual(notificationPreloads, 1);
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

async function testNotificationCloseRequestsMetaHangupBeforeLocalClose() {
    const session = new OutboundRealtimeCallSession(
        {
            call_id: "call-outbound-notification-hangup",
            phone_number_id: "phone-1",
            initial_greeting: "Hola, este mensaje debe colgar al final.",
            notification_only: true,
            hangup_after_initial_greeting: true,
            callback_url: "https://eva.test/api/voice-calls/events",
            realtime: {},
        },
        {
            sessionId: "session-outbound-notification-hangup",
        }
    );
    const actions = [];

    session.audioOutput = {
        hasPendingAudio: () => false,
    };
    session.sendCallback = async (payload) => {
        actions.push(["callback", payload.event, payload.hangup_meta, payload.reason]);
    };
    session.close = async (reason) => {
        actions.push(["close", reason]);
    };

    await session.closeAfterNotificationAudio();

    assert.deepStrictEqual(actions, [
        ["callback", "ended", true, "notification_initial_greeting_completed"],
        ["close", "notification_initial_greeting_completed"],
    ]);
}

async function testNotificationTtsGreetingUsesBase64PlaybackWhenAvailable() {
    const originalSynthesize = ttsService.synthesize;
    const synthesizeCalls = [];
    const bufferPlaybackCalls = [];
    const urlPlaybackCalls = [];

    ttsService.synthesize = async (body, options) => {
        synthesizeCalls.push({ body, options });

        return {
            audio_base64: Buffer.from("fake-mp3").toString("base64"),
            audio_url: "https://voice.test/api/audio/notification.mp3",
            format: "mp3",
            mime_type: "audio/mpeg",
        };
    };

    try {
        const session = new OutboundRealtimeCallSession(
            {
                call_id: "call-outbound-notification-base64",
                phone_number_id: "phone-1",
                initial_greeting: "Hola, este es un mensaje de notificacion.",
                notification_only: true,
                hangup_after_initial_greeting: true,
                tts: {
                    model: "gpt-4o-mini-tts",
                    voice: "ash",
                    speed: 1,
                },
                realtime: {},
            },
            {
                sessionId: "session-outbound-notification-base64",
                baseUrl: "https://voice.test",
            }
        );

        session.audioOutput = {
            enqueueAudioBuffer: async (audioBuffer, metadata) => {
                bufferPlaybackCalls.push({ audioBuffer, metadata });

                return {
                    framesSent: 1,
                    framesQueued: 1,
                    pcmBytes: 960,
                    stopped: false,
                };
            },
            enqueueAudioUrl: async (audioUrl, metadata) => {
                urlPlaybackCalls.push({ audioUrl, metadata });
            },
        };
        session.pc = {
            connectionState: "connected",
            iceConnectionState: "completed",
        };

        await session.playNotificationGreetingAudio(
            "Hola, este es un mensaje de notificacion.",
            "unit_test"
        );

        assert.strictEqual(synthesizeCalls.length, 1);
        assert.strictEqual(synthesizeCalls[0].body.return_audio_base64, true);
        assert.strictEqual(synthesizeCalls[0].body.voice, "ash");
        assert.strictEqual(bufferPlaybackCalls.length, 1);
        assert.strictEqual(bufferPlaybackCalls[0].audioBuffer.toString(), "fake-mp3");
        assert.strictEqual(bufferPlaybackCalls[0].metadata.source, "notification_initial_greeting");
        assert.strictEqual(urlPlaybackCalls.length, 0);
    } finally {
        ttsService.synthesize = originalSynthesize;
    }
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
    await testOutboundAnswerTriggersInitialGreeting();
    await testOutboundAnswerNormalizesEscapedLineBreaks();
    await testNotificationAnswerTriggersGreetingWithoutRealtimeEvent();
    await testNotificationOutboundSkipsRealtimeTransport();
    await testNotificationCloseWaitsForQueuedAudio();
    await testNotificationTtsGreetingSchedulesCloseAfterPlayback();
    await testNotificationCloseRequestsMetaHangupBeforeLocalClose();
    await testNotificationTtsGreetingUsesBase64PlaybackWhenAvailable();
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
