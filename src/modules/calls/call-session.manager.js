const crypto = require("crypto");

const CallSession = require("./call-session");
const RealtimeCallSession = require("./realtime-call-session");

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
    const SessionClass = selectSessionClass(payload);
    const session = new SessionClass(payload, {
        sessionId,
        baseUrl: options.baseUrl,
        onClosed: removeSession,
    });
    const answerSdp = await session.start();

    sessions.set(sessionId, session);
    sessionsByCallId.set(payload.call_id, sessionId);

    return {
        session,
        answerSdp,
    };
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
    if (payload && (payload.mode === "realtime" || payload.realtime)) {
        return RealtimeCallSession;
    }

    return CallSession;
}

module.exports = {
    createSession,
    getSession,
    getSessionByCallId,
    closeSession,
    listSessions,
    _selectSessionClassForTest: selectSessionClass,
};
