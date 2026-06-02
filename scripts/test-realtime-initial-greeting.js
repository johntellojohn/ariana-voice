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

testInitialGreetingUsesExactText().catch((error) => {
    console.error(error);
    process.exit(1);
});
