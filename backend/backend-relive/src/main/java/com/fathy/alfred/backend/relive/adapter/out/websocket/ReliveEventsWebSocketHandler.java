package com.fathy.alfred.backend.relive.adapter.out.websocket;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.io.IOException;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CopyOnWriteArraySet;

/**
 * /ws/relive. Broadcasts {"type":"relive-changed"}, {"type":"run-changed",...} and
 * {"type":"run-call",...}; also receives {"type":"lease","runId":...} messages from the
 * orchestrating tab (research D1) and forwards them to every registered LeaseListener (T047's
 * RunLeaseRegistry) - kept interface-only here so this package needs no application.service
 * dependency.
 */
@Component
public class ReliveEventsWebSocketHandler extends TextWebSocketHandler {

    private static final Logger log = LoggerFactory.getLogger(ReliveEventsWebSocketHandler.class);

    private final Set<WebSocketSession> sessions = new CopyOnWriteArraySet<>();
    private final List<LeaseListener> leaseListeners = new CopyOnWriteArrayList<>();
    private final ObjectMapper objectMapper = new ObjectMapper();

    public void addLeaseListener(LeaseListener listener) {
        leaseListeners.add(listener);
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        sessions.add(session);
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        sessions.remove(session);
        leaseListeners.forEach(l -> l.onSessionClosed(session.getId()));
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        try {
            JsonNode node = objectMapper.readTree(message.getPayload());
            String type = node.path("type").asText();
            String runId = node.path("runId").asText(null);
            if (runId == null) {
                return;
            }
            if ("lease".equals(type)) {
                leaseListeners.forEach(l -> l.onLeaseHeld(runId, session.getId()));
            } else if ("release".equals(type)) {
                leaseListeners.forEach(l -> l.onLeaseReleased(runId, session.getId()));
            }
        } catch (Exception e) {
            log.warn("Ignoring malformed /ws/relive message: {}", e.getMessage());
        }
    }

    /** Synchronized per-session (not the whole method) - sendMessage isn't safe to call concurrently for the same session from two threads. */
    public void broadcast(String json) {
        TextMessage message = new TextMessage(json);
        for (WebSocketSession session : sessions) {
            try {
                synchronized (session) {
                    if (session.isOpen()) {
                        session.sendMessage(message);
                    }
                }
            } catch (IOException | IllegalStateException e) {
                log.warn("Dropping WebSocket session {} after send failure: {}", session.getId(), e.getMessage());
                sessions.remove(session);
            }
        }
    }
}
