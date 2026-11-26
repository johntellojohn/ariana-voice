const axios = require("axios");
const env = require("../../config/env");

function sanitizeErrorMessage(rawMessage) {
    let text = String(rawMessage || "")
        .replace(/<[^>]*>/g, " ")
        .replace(/\bsk-(?:proj-)?[A-Za-z0-9*_-]{8,}\b/g, "sk-***")
        .replace(/\s+/g, " ")
        .trim();

    if (text.length > 400) {
        text = `${text.slice(0, 397)}...`;
    }

    return text;
}

function extractRawError(error) {
    if (!error) {
        return { message: "", code: "", status: null };
    }

    if (typeof error === "string") {
        return { message: error, code: "", status: null };
    }

    const nested = error.error && typeof error.error === "object" ? error.error : null;
    const message = String(
        nested?.message ||
            error.message ||
            error.reason ||
            ""
    );
    const code = String(
        nested?.code ||
            error.code ||
            nested?.type ||
            error.type ||
            ""
    )
        .trim()
        .toLowerCase();
    const status = Number.isFinite(Number(error.status)) ? Number(error.status) : null;

    return { message, code, status };
}

function classifyVoiceError(error, stage = "voice") {
    const { message: rawMessage, code: rawCode, status } = extractRawError(error);
    const message = sanitizeErrorMessage(rawMessage);
    const haystack = `${rawCode} ${message}`.toLowerCase();

    let code = "voice_ai_error";

    if (
        haystack.includes("openai_api_key is not configured") ||
        haystack.includes("missing api key") ||
        haystack.includes("api key is required")
    ) {
        code = "openai_missing_api_key";
    } else if (
        rawCode === "invalid_api_key" ||
        haystack.includes("invalid_api_key") ||
        haystack.includes("incorrect api key") ||
        haystack.includes("invalid api key") ||
        status === 401
    ) {
        code = "openai_invalid_api_key";
    } else if (
        rawCode === "insufficient_quota" ||
        haystack.includes("insufficient_quota") ||
        haystack.includes("exceeded your current quota") ||
        haystack.includes("billing_hard_limit")
    ) {
        code = "openai_insufficient_quota";
    } else if (
        rawCode === "rate_limit_exceeded" ||
        haystack.includes("rate limit") ||
        status === 429
    ) {
        code = "openai_rate_limit";
    } else if (
        rawCode === "model_not_found" ||
        haystack.includes("model_not_found") ||
        haystack.includes("does not exist or you do not have access")
    ) {
        code = "openai_model_error";
    } else if (rawCode) {
        code = rawCode.replace(/[^a-z0-9_]+/g, "_").slice(0, 60) || "voice_ai_error";
    }

    return {
        code,
        stage: String(stage || "voice"),
        status,
        message: message || "Error en el motor de voz IA.",
    };
}

function reportCallErrorToLaravel({
    callbackUrl,
    sessionId,
    callId,
    tenant,
    agentId,
    error,
    stage = "voice",
}) {
    if (!callbackUrl || !callId) {
        return Promise.resolve(null);
    }

    const classified =
        error && typeof error === "object" && error.code && error.stage && error.message
            ? {
                  code: String(error.code),
                  stage: String(error.stage),
                  status: error.status ?? null,
                  message: sanitizeErrorMessage(error.message),
              }
            : classifyVoiceError(error, stage);

    const payload = {
        event: "error",
        session_id: sessionId || null,
        call_id: callId,
        tenant: tenant || null,
        agent_id: agentId || null,
        error_code: classified.code,
        stage: classified.stage,
        http_status: classified.status,
        message: classified.message,
    };

    return axios
        .post(callbackUrl, payload, {
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                Authorization: env.voiceApiToken
                    ? `Bearer ${env.voiceApiToken}`
                    : undefined,
            },
            timeout: Math.min(5000, env.callCallbackTimeoutMs || 5000),
        })
        .then((response) => response.data)
        .catch(() => null);
}

module.exports = {
    sanitizeErrorMessage,
    classifyVoiceError,
    reportCallErrorToLaravel,
};

