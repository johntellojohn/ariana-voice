const callSessionManager = require("./call-session.manager");
const env = require("../../config/env");

function getBaseUrl(req) {
    if (env.publicBaseUrl) {
        return env.publicBaseUrl;
    }

    return `${req.protocol}://${req.get("host")}`;
}

async function createSession(req, res, next) {
    try {
        const { session, answerSdp } = await callSessionManager.createSession(
            req.body,
            {
                baseUrl: getBaseUrl(req),
            }
        );

        res.json({
            ok: true,
            data: {
                session_id: session.sessionId,
                answer_sdp: answerSdp,
            },
        });
    } catch (error) {
        next(error);
    }
}

async function createOutboundSession(req, res, next) {
    try {
        const { session, offerSdp } = await callSessionManager.createOutboundSession(
            req.body,
            {
                baseUrl: getBaseUrl(req),
            }
        );

        res.json({
            ok: true,
            data: {
                session_id: session.sessionId,
                offer_sdp: offerSdp,
            },
        });
    } catch (error) {
        next(error);
    }
}

function listSessions(req, res) {
    res.json({
        ok: true,
        data: callSessionManager.listSessions(),
    });
}

function showSession(req, res) {
    const session = callSessionManager.getSession(req.params.session_id);

    if (!session) {
        return res.status(404).json({
            ok: false,
            message: "Call session not found",
        });
    }

    return res.json({
        ok: true,
        data: session.snapshot(),
    });
}

async function closeSession(req, res, next) {
    try {
        const session = await callSessionManager.closeSession(
            req.params.session_id,
            req.body.reason || "closed_by_laravel"
        );

        res.json({
            ok: true,
            data: session.snapshot(),
        });
    } catch (error) {
        next(error);
    }
}

async function applySessionAnswer(req, res, next) {
    try {
        const snapshot = await callSessionManager.applySessionAnswer(
            req.params.session_id,
            req.body.answer_sdp || req.body.sdp || ""
        );

        res.json({
            ok: true,
            data: snapshot,
        });
    } catch (error) {
        next(error);
    }
}

async function connectAgent(req, res, next) {
    try {
        const { answer_sdp: answerSdp, snapshot } = await callSessionManager.connectAgent(
            req.params.session_id,
            req.body.offer_sdp || req.body.sdp || "",
            {
                agent_id: req.body.agent_id || req.body.agentId || null,
            }
        );

        res.json({
            ok: true,
            data: {
                answer_sdp: answerSdp,
                session: snapshot,
            },
        });
    } catch (error) {
        next(error);
    }
}

module.exports = {
    createSession,
    createOutboundSession,
    listSessions,
    showSession,
    applySessionAnswer,
    connectAgent,
    closeSession,
};
