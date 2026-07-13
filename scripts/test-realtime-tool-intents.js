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

function testCustomerLookupToolsHaveSeparateResponsibilities() {
    const session = new RealtimeCallSession({
        call_id: "call-test",
        dynamic_tools: [
            {
                type: "function",
                function: {
                    name: "consultar_cliente",
                    description: "Busca informacion de otro cliente existente en EVA.",
                    parameters: {
                        type: "object",
                        properties: {
                            criterio: { type: "string" },
                        },
                        required: ["criterio"],
                        additionalProperties: false,
                    },
                },
            },
        ],
    }, { sessionId: "session-test" });
    const searchCustomer = findTool(session, "search_customer");
    const consultarCliente = findTool(session, "consultar_cliente");

    assert(searchCustomer, "search_customer tool not found");
    assert(consultarCliente, "consultar_cliente tool not found");
    assert.match(searchCustomer.description, /llamada actual/i);
    assert.match(searchCustomer.description, /No la uses para buscar otros clientes/i);
    assert.match(consultarCliente.description, /otro cliente existente/i);
    assert(consultarCliente.parameters.required.includes("criterio"));
}

testKnowledgeToolWinsInformationalTeamQuestions();
testCustomerLookupToolsHaveSeparateResponsibilities();
