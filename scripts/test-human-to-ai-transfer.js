const assert = require("assert");

const RealtimeCallSession = require("../src/modules/calls/realtime-call-session");

function humanWebSocket() {
    return {
        readyState: 1,
        closeCalls: [],
        close(code, reason) {
            this.closeCalls.push({ code, reason });
            this.readyState = 3;
        },
    };
}

async function testHumanTransferActivatesSelectedAiAfterRealtimeIsReady() {
    const session = new RealtimeCallSession({
        call_id: "call-human-to-ai",
        agent_id: 10,
        realtime: { instructions: "Agente original" },
    }, {
        sessionId: "session-human-to-ai",
    });
    const ws = humanWebSocket();
    let audioStarts = 0;
    let greetingReason = null;

    session.pc = { connectionState: "connected", iceConnectionState: "connected" };
    session.humanTransferActive = true;
    session.realtimeClosedForHumanTransfer = true;
    session.realtimeReady = false;
    session.status = "agent_ws_connected";
    session.agentWs = ws;
    session.activeAgentId = 77;
    session.audioOutput = {
        start() {
            audioStarts += 1;
        },
    };
    session.connectRealtime = async () => {
        assert.strictEqual(ws.closeCalls.length, 0, "human must remain connected while AI prepares");
        session.realtimeReady = true;
        session.realtimeSocket = { readyState: 1 };
    };
    session.playInitialGreeting = async (reason) => {
        greetingReason = reason;
        return true;
    };

    const snapshot = await session.activateAi({
        transfer_id: "transfer-1",
        agent_id: 25,
        tools_base_url: "https://eva.test/api/voice-agent/tools",
        dynamic_tools: [],
        realtime: {
            model: "gpt-realtime",
            voice: "coral",
            instructions: "Eres el agente seleccionado.",
        },
        handoff_context: "El cliente ya confirmo su identidad y necesita reagendar.",
        handoff_greeting: "Hola, continuare ayudandote con tu solicitud.",
    });

    assert.strictEqual(snapshot.status, "ai_active");
    assert.strictEqual(session.agentId, 25);
    assert.strictEqual(session.humanTransferActive, false);
    assert.strictEqual(session.realtimeClosedForHumanTransfer, false);
    assert.strictEqual(session.agentWs, null);
    assert.strictEqual(audioStarts, 1);
    assert.deepStrictEqual(ws.closeCalls, [{ code: 1000, reason: "transferred_to_ai" }]);
    assert.strictEqual(greetingReason, "human_to_ai_transfer");
    assert(session.instructions().includes("necesita reagendar"));
    assert.strictEqual(session.recording.finalized, false);
    assert.strictEqual(session.recording.participantTransitions.length, 1);
    assert.strictEqual(session.recording.participantTransitions[0].from_id, 77);
    assert.strictEqual(session.recording.participantTransitions[0].to_id, 25);

    const duplicateSnapshot = await session.activateAi({
        transfer_id: "transfer-1",
        agent_id: 25,
    });
    assert.strictEqual(duplicateSnapshot.status, "ai_active");
    assert.strictEqual(session.recording.participantTransitions.length, 1);
}

async function testHumanRemainsConnectedWhenAiPreparationFails() {
    const session = new RealtimeCallSession({
        call_id: "call-human-to-ai-failure",
        agent_id: 10,
        realtime: { instructions: "Agente original" },
    }, {
        sessionId: "session-human-to-ai-failure",
    });
    const ws = humanWebSocket();

    session.pc = { connectionState: "connected", iceConnectionState: "connected" };
    session.humanTransferActive = true;
    session.realtimeClosedForHumanTransfer = true;
    session.status = "agent_ws_connected";
    session.agentWs = ws;
    session.activeAgentId = 77;
    session.connectRealtime = async () => {
        throw new Error("OpenAI unavailable");
    };

    await assert.rejects(
        () => session.activateAi({
            transfer_id: "transfer-failure",
            agent_id: 25,
            realtime: { instructions: "Nuevo agente" },
        }),
        /OpenAI unavailable/
    );

    assert.strictEqual(session.humanTransferActive, true);
    assert.strictEqual(session.agentWs, ws);
    assert.strictEqual(session.activeAgentId, 77);
    assert.strictEqual(session.agentId, 10);
    assert.strictEqual(session.status, "agent_ws_connected");
    assert.strictEqual(ws.closeCalls.length, 0);
    assert.strictEqual(session.recording.participantTransitions.length, 0);
}

(async () => {
    await testHumanTransferActivatesSelectedAiAfterRealtimeIsReady();
    await testHumanRemainsConnectedWhenAiPreparationFails();
    console.log("human to AI transfer tests passed");
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
