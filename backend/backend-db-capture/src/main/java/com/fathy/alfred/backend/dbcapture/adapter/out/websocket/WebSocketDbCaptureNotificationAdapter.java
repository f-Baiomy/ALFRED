package com.fathy.alfred.backend.dbcapture.adapter.out.websocket;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureNotificationPort;
import org.springframework.stereotype.Component;

import java.util.LinkedHashMap;
import java.util.Map;

/** Serialises change signals for /ws/db-capture (contracts/websocket.md). Ids and counts only, never statement content. */
@Component
public class WebSocketDbCaptureNotificationAdapter implements DbCaptureNotificationPort {

    private final DbCaptureEventsWebSocketHandler handler;
    private final ObjectMapper objectMapper;

    public WebSocketDbCaptureNotificationAdapter(DbCaptureEventsWebSocketHandler handler, ObjectMapper objectMapper) {
        this.handler = handler;
        this.objectMapper = objectMapper;
    }

    @Override
    public void statementsAppended(String callId, int lastSeq, boolean summaryChanged) {
        Map<String, Object> m = event("statements-appended");
        m.put("callId", callId);
        m.put("lastSeq", lastSeq);
        m.put("summaryChanged", summaryChanged);
        send(m);
    }

    @Override
    public void outsideAppended(String thread, int count) {
        Map<String, Object> m = event("outside-appended");
        m.put("thread", thread);
        m.put("count", count);
        send(m);
    }

    @Override
    public void captureSettingsChanged(String project) {
        Map<String, Object> m = event("capture-settings-changed");
        m.put("project", project);
        send(m);
    }

    @Override
    public void agentStatusChanged(String project, boolean attached) {
        Map<String, Object> m = event("agent-status-changed");
        m.put("project", project);
        m.put("attached", attached);
        send(m);
    }

    private static Map<String, Object> event(String type) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("type", type);
        return m;
    }

    private void send(Map<String, Object> event) {
        try {
            handler.broadcast(objectMapper.writeValueAsString(event));
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }
}
