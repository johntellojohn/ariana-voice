const crypto = require("crypto");

const CallSession = require("./call-session");
const RealtimeCallSession = require("./realtime-call-session");
const OutboundRealtimeCallSession = require("./outbound-realtime-call-session");
const HumanBridgeCallSession = require("./human-bridge-call-session");

const sessions = new Map();
const sessionsByCallId = new Map();

function validateCreatePayload(payload) {
    const requiredFields = ["call_id", "phone_number_id", "offer_sdp"];

    for (const field of requiredFields) {
        if (!payload[field]) {
            const error = new Error(`${field} is required`);
            error.status = 422;
            throw error;
        }
    }

    if (!String(payload.offer_sdp).startsWith("v=0")) {
        const error = new Error("offer_sdp must be a valid SDP offer");
        error.status = 422;
        throw error;
    }
}

function validateOutboundCreatePayload(payload) {
    const requiredFields = ["call_id", "phone_number_id"];

    for (const field of requiredFields) {
        if (!payload[field]) {
            const error = new Error(`${field} is required`);
            error.status = 422;
            throw error;
        }
    }
}

async function createSession(payload, options = {}) {
    validateCreatePayload(payload);

    const existingSessionId = sessionsByCallId.get(payload.call_id);

    if (existingSessionId) {
        const existingSession = sessions.get(existingSessionId);

        if (existingSession && !existingSession.closedAt) {
            const error = new Error("A live session already exists for this call_id");
            error.status = 409;
            throw error;
        }
    }

    const sessionId = crypto.randomUUID();
    let SessionClass = selectSessionClass(payload);
    const session = new SessionClass(payload, {
        sessionId,
        baseUrl: options.baseUrl,
        onClosed: removeSession,
    });
    let answerSdp;

    try {
        answerSdp = await session.start();
    } catch (error) {
        if (SessionClass !== RealtimeCallSession) {
            throw error;
        }

        console.warn(
            `[call:${sessionId} call_id:${payload.call_id}] realtime session failed before answer_sdp, falling back to legacy V1`,
            JSON.stringify({ error: error.message })
        );

        await session.close("realtime_start_failed").catch(() => {});
        SessionClass = CallSession;
        const fallbackSession = new SessionClass(payload, {
            sessionId,
            baseUrl: options.baseUrl,
            onClosed: removeSession,
        });
        answerSdp = await fallbackSession.start();
        sessions.set(sessionId, fallbackSession);
        sessionsByCallId.set(payload.call_id, sessionId);

        return {
            session: fallbackSession,
            answerSdp,
            fallback: "legacy_v1",
        };
    }

    sessions.set(sessionId, session);
    sessionsByCallId.set(payload.call_id, sessionId);

    return {
        session,
        answerSdp,
    };
}

async function createOutboundSession(payload, options = {}) {
    validateOutboundCreatePayload(payload);

    const existingSessionId = sessionsByCallId.get(payload.call_id);

    if (existingSessionId) {
        const existingSession = sessions.get(existingSessionId);

        if (existingSession && !existingSession.closedAt) {
            const error = new Error("A live session already exists for this call_id");
            error.status = 409;
            throw error;
        }
    }

    const sessionId = crypto.randomUUID();
    const session = new OutboundRealtimeCallSession(payload, {
        sessionId,
        baseUrl: options.baseUrl,
        onClosed: removeSession,
    });
    const offerSdp = await session.start();

    sessions.set(sessionId, session);
    sessionsByCallId.set(payload.call_id, sessionId);

    return {
        session,
        offerSdp,
    };
}

async function applySessionAnswer(sessionId, answerSdp) {
    const session = getSession(sessionId);

    if (!session) {
        const error = new Error("Call session not found");
        error.status = 404;
        throw error;
    }

    if (typeof session.applyAnswer !== "function") {
        const error = new Error("Call session does not accept a delayed answer");
        error.status = 409;
        throw error;
    }

    return session.applyAnswer(answerSdp);
}

async function connectAgent(sessionId, offerSdp, options = {}) {
    const session = getSession(sessionId);

    if (!session) {
        const error = new Error("Call session not found");
        error.status = 404;
        throw error;
    }

    if (typeof session.connectAgent !== "function") {
        const error = new Error("Call session does not accept agent bridge connections");
        error.status = 409;
        throw error;
    }

    return session.connectAgent(offerSdp, options);
}

function removeSession(session) {
    sessions.delete(session.sessionId);

    if (session.callId) {
        sessionsByCallId.delete(session.callId);
    }
}

function getSession(sessionId) {
    return sessions.get(sessionId) || null;
}

function getSessionByCallId(callId) {
    const sessionId = sessionsByCallId.get(callId);

    return sessionId ? getSession(sessionId) : null;
}

async function closeSession(sessionId, reason = "closed") {
    const session = getSession(sessionId);

    if (!session) {
        const error = new Error("Call session not found");
        error.status = 404;
        throw error;
    }

    await session.close(reason);
    removeSession(session);

    return session;
}

function listSessions() {
    return Array.from(sessions.values()).map((session) => session.snapshot());
}

function selectSessionClass(payload) {
    if (payload && payload.mode === "human_bridge") {
        return HumanBridgeCallSession;
    }

    if (payload && (payload.mode === "realtime" || payload.realtime)) {
        return RealtimeCallSession;
    }

    return CallSession;
}

module.exports = {
    createSession,
    createOutboundSession,
    applySessionAnswer,
    connectAgent,
    getSession,
    getSessionByCallId,
    closeSession,
    listSessions,
    _selectSessionClassForTest: selectSessionClass,
};
