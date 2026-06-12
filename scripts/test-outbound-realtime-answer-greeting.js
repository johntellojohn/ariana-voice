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

(async () => {
    await testOutboundAnswerTriggersInitialGreeting();
    await testOutboundAnswerNormalizesEscapedLineBreaks();
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
