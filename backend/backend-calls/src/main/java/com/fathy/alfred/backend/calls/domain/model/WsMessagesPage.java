package com.fathy.alfred.backend.calls.domain.model;

import java.util.List;

/** One page of a call's WebSocket messages, plus how many earlier ones the per-connection cap has already dropped. */
public record WsMessagesPage(List<WsMessage> messages, int total, int dropped) {

    public WsMessagesPage {
        messages = messages == null ? List.of() : List.copyOf(messages);
    }
}
