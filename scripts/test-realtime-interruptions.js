const assert = require("assert");

const { SpeechInterruptionGate } = require("../src/modules/calls/speech-interruption-gate");

async function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testShortNoiseDoesNotInterrupt() {
    const interruptions = [];
    const gate = new SpeechInterruptionGate({
        debounceMs: 30,
        onInterrupt: (reason) => interruptions.push(reason),
    });

    gate.speechStarted("user_speech_started");
    await wait(10);
    gate.speechStopped("short_noise");
    await wait(35);

    assert.deepStrictEqual(interruptions, []);
}

async function testSustainedSpeechInterrupts() {
    const interruptions = [];
    const gate = new SpeechInterruptionGate({
        debounceMs: 20,
        onInterrupt: (reason) => interruptions.push(reason),
    });

    gate.speechStarted("user_speech_started");
    await wait(35);

    assert.deepStrictEqual(interruptions, ["user_speech_started"]);
}

async function testDebounceChecksLocalSpeechBeforeInterrupting() {
    const interruptions = [];
    const gate = new SpeechInterruptionGate({
        debounceMs: 20,
        shouldInterrupt: () => false,
        onInterrupt: (reason) => interruptions.push(reason),
    });

    gate.speechStarted("user_speech_started");
    await wait(35);

    assert.deepStrictEqual(interruptions, []);
}

async function testZeroDebounceInterruptsImmediately() {
    const interruptions = [];
    const gate = new SpeechInterruptionGate({
        debounceMs: 0,
        onInterrupt: (reason) => interruptions.push(reason),
    });

    gate.speechStarted("user_speech_started");

    assert.deepStrictEqual(interruptions, ["user_speech_started"]);
}

async function run() {
    await testShortNoiseDoesNotInterrupt();
    await testSustainedSpeechInterrupts();
    await testDebounceChecksLocalSpeechBeforeInterrupting();
    await testZeroDebounceInterruptsImmediately();
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
