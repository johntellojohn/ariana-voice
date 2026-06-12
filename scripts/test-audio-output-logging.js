const assert = require("assert");

const { AudioOutput } = require("../src/modules/calls/audio-output");

async function playbackOneFrame(options = {}) {
    const logs = [];
    const source = {
        onData: () => {},
    };
    const output = new AudioOutput(source, {
        frameMs: 10,
        logger: (message, data) => logs.push({ message, data }),
        ...options,
    });

    const playback = output.enqueuePcm(Buffer.alloc(output.frameBytes), {
        source: "unit_test",
    });

    output.tick();
    await playback;

    return logs.map((entry) => entry.message);
}

async function testAudioChunkLogsAreDisabledByDefault() {
    const messages = await playbackOneFrame();

    assert.strictEqual(messages.includes("audio output queued"), false);
    assert.strictEqual(messages.includes("audio output sent"), false);
}

async function testAudioChunkLogsCanBeEnabled() {
    const messages = await playbackOneFrame({
        logAudioChunks: true,
    });

    assert.strictEqual(messages.includes("audio output queued"), true);
    assert.strictEqual(messages.includes("audio output sent"), true);
}

(async () => {
    await testAudioChunkLogsAreDisabledByDefault();
    await testAudioChunkLogsCanBeEnabled();
    console.log("audio output logging tests passed");
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
