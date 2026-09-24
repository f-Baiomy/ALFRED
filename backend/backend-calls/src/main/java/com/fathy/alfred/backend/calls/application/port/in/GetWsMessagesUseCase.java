package com.fathy.alfred.backend.calls.application.port.in;

import com.fathy.alfred.backend.calls.domain.model.WsMessagesPage;

/** Inbound port: one call's WebSocket messages, paginated - see GET /calls/{id}/ws-messages. */
public interface GetWsMessagesUseCase {

    WsMessagesPage getWsMessages(String callId, int offset, int limit);
}
