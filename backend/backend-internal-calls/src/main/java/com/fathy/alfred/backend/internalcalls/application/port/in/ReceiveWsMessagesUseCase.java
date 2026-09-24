package com.fathy.alfred.backend.internalcalls.application.port.in;

import com.fathy.alfred.backend.internalcalls.domain.model.WsMessage;

import java.util.List;

/** Inbound port: the proxy's per-connection WebSocket message batches - see PX/ws_messages.py. */
public interface ReceiveWsMessagesUseCase {

    void receiveWsMessages(String callId, List<WsMessage> messages, boolean closed, Integer closeCode);
}
