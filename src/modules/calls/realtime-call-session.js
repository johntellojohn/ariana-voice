class RealtimeCallSession {
    constructor(payload, options = {}) {
        this.sessionId = options.sessionId;
        this.baseUrl = options.baseUrl;
        this.onClosed = options.onClosed || null;
        this.callId = payload.call_id;
        this.phoneNumberId = payload.phone_number_id;
        this.offerSdp = payload.offer_sdp;
        this.tenant = payload.tenant || null;
        this.agentId = payload.agent_id || null;
        this.toolsBaseUrl = payload.tools_base_url || null;
        this.realtime = payload.realtime || {};
        this.createdAt = new Date();
        this.closedAt = null;
        this.status = "created";
    }

    async start() {
        const error = new Error("Realtime call session bridge is not implemented yet");
        error.status = 501;
        throw error;
    }

    async close(reason = "closed") {
        if (this.closedAt) {
            return;
        }

        this.closedAt = new Date();
        this.status = "closed";
        this.closeReason = reason;

        if (this.onClosed) {
            this.onClosed(this);
        }
    }

    snapshot() {
        return {
            session_id: this.sessionId,
            call_id: this.callId,
            phone_number_id: this.phoneNumberId,
            tenant: this.tenant,
            agent_id: this.agentId,
            status: this.status,
            realtime: true,
            created_at: this.createdAt.toISOString(),
            closed_at: this.closedAt ? this.closedAt.toISOString() : null,
        };
    }
}

module.exports = RealtimeCallSession;
