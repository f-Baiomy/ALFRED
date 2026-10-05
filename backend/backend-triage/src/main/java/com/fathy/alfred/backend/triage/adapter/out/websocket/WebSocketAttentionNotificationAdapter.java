package com.fathy.alfred.backend.triage.adapter.out.websocket;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.triage.application.port.out.AttentionNotificationPort;
import org.springframework.stereotype.Component;

import java.util.Collection;
import java.util.List;
import java.util.Map;

@Component
public class WebSocketAttentionNotificationAdapter implements AttentionNotificationPort {

    private final TriageEventsWebSocketHandler handler;
    private final ObjectMapper objectMapper = new ObjectMapper();

    public WebSocketAttentionNotificationAdapter(TriageEventsWebSocketHandler handler) {
        this.handler = handler;
    }

    @Override
    public void attentionChanged(Collection<String> callIds) {
        try {
            handler.broadcast(objectMapper.writeValueAsString(Map.of("type", "attention-changed", "callIds", List.copyOf(callIds))));
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Could not serialise an attention-changed event", e);
        }
    }
}
