package com.fathy.alfred.backend.logs.adapter.out.websocket;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.logs.application.port.out.LogNotificationPort;
import com.fathy.alfred.backend.logs.domain.model.IngestProgress;
import org.springframework.stereotype.Component;

import java.util.LinkedHashMap;
import java.util.Map;

/** Serialises change signals for /ws/logs. Payloads carry ids and counts only, never line content. */
@Component
public class WebSocketLogNotificationAdapter implements LogNotificationPort {

    private final LogEventsWebSocketHandler handler;
    private final ObjectMapper objectMapper;

    public WebSocketLogNotificationAdapter(LogEventsWebSocketHandler handler, ObjectMapper objectMapper) {
        this.handler = handler;
        this.objectMapper = objectMapper;
    }

    private void send(Map<String, Object> event) {
        try {
            handler.broadcast(objectMapper.writeValueAsString(event));
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }

    private static Map<String, Object> event(String type, String sourceId) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("type", type);
        if (sourceId != null) {
            m.put("sourceId", sourceId);
        }
        return m;
    }

    @Override
    public void linesAdded(String sourceId, long count, long newestTs) {
        Map<String, Object> m = event("lines-added", sourceId);
        m.put("count", count);
        m.put("newestTs", newestTs);
        send(m);
    }

    @Override
    public void progress(IngestProgress p) {
        Map<String, Object> m = event("input-progress", p.sourceId());
        m.put("inputId", p.inputId());
        m.put("status", p.status());
        m.put("reason", p.reason());
        m.put("lines", p.lines());
        m.put("bytes", p.bytes());
        m.put("totalBytes", p.totalBytes());
        m.put("unparsed", p.unparsed());
        m.put("mismatch", p.mismatch());
        m.put("newField", p.newField());
        send(m);
    }

    @Override
    public void structureChanged(String sourceId, String rebuilding) {
        Map<String, Object> m = event("structure-changed", sourceId);
        m.put("rebuilding", rebuilding);
        send(m);
    }

    @Override
    public void sourcesChanged() {
        send(event("sources-changed", null));
    }

    @Override
    public void sessionsChanged(String sourceId) {
        send(event("sessions-changed", sourceId));
    }

    @Override
    public void commentChanged(String sourceId, String lineId) {
        Map<String, Object> m = event("comment-changed", sourceId);
        m.put("lineId", lineId);
        send(m);
    }
}
