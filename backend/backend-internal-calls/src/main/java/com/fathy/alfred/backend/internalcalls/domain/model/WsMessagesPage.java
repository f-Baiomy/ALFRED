package com.fathy.alfred.backend.internalcalls.domain.model;

import java.util.List;

/** Mirrors backend-calls' own WsMessagesPage record. */
public record WsMessagesPage(List<WsMessage> messages, int total, int dropped) {

    public WsMessagesPage {
        messages = messages == null ? List.of() : List.copyOf(messages);
    }
}
