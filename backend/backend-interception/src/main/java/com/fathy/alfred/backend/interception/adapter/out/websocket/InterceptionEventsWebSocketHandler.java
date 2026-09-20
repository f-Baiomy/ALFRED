package com.fathy.alfred.backend.interception.adapter.out.websocket;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.io.IOException;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArraySet;

/**
 * The Interception page opens this socket and listens; it never sends. Same shape as
 * backend-profiles' ProfileEventsWebSocketHandler, duplicated rather than shared because each
 * slice's WebSocket infrastructure is self-contained (see docs/frontend-architecture.md).
 */
@Component
public class InterceptionEventsWebSocketHandler extends TextWebSocketHandler {

    private static final Logger log = LoggerFactory.getLogger(InterceptionEventsWebSocketHandler.class);

    private final Set<WebSocketSession> sessions = new CopyOnWriteArraySet<>();

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        sessions.add(session);
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        sessions.remove(session);
    }

    /** Synchronized per-session, not per-method - sendMessage is not safe to call concurrently for the same session. */
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
