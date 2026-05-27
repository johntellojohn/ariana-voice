const axios = require("axios");
const env = require("../../config/env");

async function sendVoiceTurn(payload) {
    const url = `${env.laravelApiUrl.replace(/\/$/, "")}/api/voice/turn`;

    const response = await axios.post(url, payload, {
        headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: env.laravelApiToken
                ? `Bearer ${env.laravelApiToken}`
                : undefined,
        },
        timeout: 30000,
    });

    return response.data;
}

module.exports = {
    sendVoiceTurn,
};
