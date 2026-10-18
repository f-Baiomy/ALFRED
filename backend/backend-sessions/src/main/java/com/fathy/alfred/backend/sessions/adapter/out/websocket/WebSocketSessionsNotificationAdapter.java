package com.fathy.alfred.backend.sessions.adapter.out.websocket;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.sessions.application.port.out.SessionsNotificationPort;
import org.springframework.stereotype.Component;

import java.util.LinkedHashMap;
import java.util.Map;

@Component
public class WebSocketSessionsNotificationAdapter implements SessionsNotificationPort {

    private final SessionsEventsWebSocketHandler handler;
    private final ObjectMapper objectMapper = new ObjectMapper();

    public WebSocketSessionsNotificationAdapter(SessionsEventsWebSocketHandler handler) {
        this.handler = handler;
    }

    @Override
    public void changed(String what, String boardId) {
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("type", "sessions-changed");
        event.put("what", what);
        if (boardId != null) {
            event.put("boardId", boardId);
        }
        try {
            handler.broadcast(objectMapper.writeValueAsString(event));
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Could not serialise a sessions-changed event", e);
        }
    }
}
