const assert = require("assert");

const RealtimeCallSession = require("../src/modules/calls/realtime-call-session");

function findTool(session, name) {
    return session.tools().find((tool) => tool.name === name);
}

function testKnowledgeToolWinsInformationalTeamQuestions() {
    const session = new RealtimeCallSession({ call_id: "call-test" }, { sessionId: "session-test" });
    const searchKnowledge = findTool(session, "search_knowledge");
    const checkAvailability = findTool(session, "check_availability");

    assert(searchKnowledge, "search_knowledge tool not found");
    assert(checkAvailability, "check_availability tool not found");
    assert.match(searchKnowledge.description, /preguntas informativas/i);
    assert.match(searchKnowledge.description, /miembros del equipo/i);
    assert.match(searchKnowledge.description, /aunque mencione capacitaciones/i);
    assert.match(checkAvailability.description, /No la uses para preguntas informativas/i);
}

testKnowledgeToolWinsInformationalTeamQuestions();
