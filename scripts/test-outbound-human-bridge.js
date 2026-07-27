const assert = require("assert");

const OutboundHumanBridgeCallSession = require("../src/modules/calls/outbound-human-bridge-call-session");
const callSessionManager = require("../src/modules/calls/call-session.manager");

async function testOutboundHumanBridgeAppliesMetaAnswer() {
    const session = new OutboundHumanBridgeCallSession(
        {
            call_id: "outbound-human-1",
            phone_number_id: "phone-1",
            mode: "human_bridge",
            wait_tone_enabled: false,
        },
        {
            sessionId: "session-outbound-human-1",
        }
    );
    let appliedSdp = "";

    session.metaPc = {
        remoteDescription: null,
        currentRemoteDescription: null,
        setRemoteDescription: async (description) => {
            appliedSdp = description.sdp;
            session.metaPc.remoteDescription = description;
        },
    };

    const snapshot = await session.applyAnswer(
        "v=0\\r\\no=- 1 2 IN IP4 127.0.0.1\\r\\ns=-\\r\\nt=0 0"
    );

    assert.strictEqual(snapshot.status, "answer_applied");
    assert.strictEqual(snapshot.mode, "human_bridge");
    assert.strictEqual(appliedSdp, "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n");
}

function testManagerSelectsOutboundHumanBridge() {
    assert.strictEqual(
        callSessionManager._selectOutboundSessionClassForTest({
            mode: "human_bridge",
        }),
        OutboundHumanBridgeCallSession
    );
}

(async () => {
    testManagerSelectsOutboundHumanBridge();
    await testOutboundHumanBridgeAppliesMetaAnswer();
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
