package com.fathy.alfred.backend.relive.adapter.out.websocket;

import com.fasterxml.jackson.databind.JsonNode;
import com.fathy.alfred.backend.relive.application.port.out.ReliveNotificationPort;
import org.springframework.stereotype.Component;

@Component
public class WebSocketReliveNotificationAdapter implements ReliveNotificationPort {

    private static final String CHANGED_EVENT = "{\"type\":\"relive-changed\"}";

    private final ReliveEventsWebSocketHandler handler;

    public WebSocketReliveNotificationAdapter(ReliveEventsWebSocketHandler handler) {
        this.handler = handler;
    }

    @Override
    public void cycleChanged() {
        handler.broadcast(CHANGED_EVENT);
    }

    @Override
    public void runChanged(String cycleId, String runId) {
        handler.broadcast("{\"type\":\"run-changed\",\"cycleId\":\"" + esc(cycleId) + "\",\"runId\":\"" + esc(runId) + "\"}");
    }

    @Override
    public void runCall(JsonNode eventJson) {
        handler.broadcast(eventJson.toString());
    }

    private static String esc(String s) {
        return s == null ? "" : s.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
