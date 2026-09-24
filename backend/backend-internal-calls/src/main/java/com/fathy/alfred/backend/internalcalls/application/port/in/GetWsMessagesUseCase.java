package com.fathy.alfred.backend.internalcalls.application.port.in;

import com.fathy.alfred.backend.internalcalls.domain.model.WsMessagesPage;

/** Inbound port: one call's WebSocket messages, paginated - see GET /internal-calls/{id}/ws-messages. */
public interface GetWsMessagesUseCase {

    WsMessagesPage getWsMessages(String callId, int offset, int limit);
}
