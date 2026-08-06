const assert = require("assert");

const env = require("../src/config/env");
const HumanBridgeCallSession = require("../src/modules/calls/human-bridge-call-session");

function createSession(id) {
    const session = new HumanBridgeCallSession({
        call_id: `call-${id}`,
        phone_number_id: "phone-1",
        offer_sdp: "v=0\r\n",
        callback_url: "https://eva.test/api/voice-calls/events",
    }, {
        sessionId: `session-${id}`,
    });

    session.recording.finalize = async () => null;
    session.startWaitingPlayback = async () => {};

    return session;
}

async function testRemoteCloseNotifiesEndedOnce() {
    const session = createSession("remote-ended");
    const callbacks = [];
    session.sendCallback = async (payload) => callbacks.push(payload);

    await session.close("meta_track_ended");
    await session.close("meta_track_ended");

    assert.strictEqual(callbacks.length, 1);
    assert.strictEqual(callbacks[0].event, "ended");
    assert.strictEqual(callbacks[0].reason, "meta_track_ended");
    assert.strictEqual(callbacks[0].call_id, "call-remote-ended");
}

async function testLaravelFinalCloseDoesNotCallback() {
    const session = createSession("laravel-ended");
    const callbacks = [];
    session.sendCallback = async (payload) => callbacks.push(payload);

    await session.close("meta_ended");

    assert.deepStrictEqual(callbacks, []);
}

async function testDisconnectedUsesGraceAndCanRecover() {
    const originalGraceMs = env.callDisconnectGraceMs;
    env.callDisconnectGraceMs = 250;

    try {
        const disconnected = createSession("disconnect-timeout");
        const closeReasons = [];
        disconnected.close = async (reason) => {
            closeReasons.push(reason);
            disconnected.closedAt = new Date();
            disconnected.clearMetaDisconnectClose();
        };

        disconnected.handleIceState("meta", "disconnected");
        assert.deepStrictEqual(closeReasons, []);
        await wait(300);
        assert.deepStrictEqual(closeReasons, ["meta_ice_disconnected_timeout"]);

        const recovered = createSession("disconnect-recovered");
        const recoveredCloseReasons = [];
        recovered.close = async (reason) => recoveredCloseReasons.push(reason);
        recovered.handlePeerState("meta", "disconnected");
        recovered.handlePeerState("meta", "connected");
        await wait(300);
        assert.deepStrictEqual(recoveredCloseReasons, []);
    } finally {
        env.callDisconnectGraceMs = originalGraceMs;
    }
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
    await testRemoteCloseNotifiesEndedOnce();
    await testLaravelFinalCloseDoesNotCallback();
    await testDisconnectedUsesGraceAndCanRecover();
    console.log("human bridge lifecycle tests passed");
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
