package com.fathy.alfred.backend.internalcalls.adapter.out.websocket;

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
 * The dashboard doesn't send anything meaningful over this socket - it just opens it and listens.
 * Every connected session is tracked here so WebSocketCallNotificationAdapter can broadcast to
 * all of them; a session that errors on send is assumed dead and dropped rather than retried.
 *
 * <p>Two-phase logging means {@code broadcast} can be called twice per call (once at prepare, once
 * at complete) from two different HTTP request-handling threads - {@code
 * WebSocketSession.sendMessage} is not safe to call concurrently for the *same* session from two
 * threads, so sends are synchronized per-session (not the whole method), matching
 * backend-calls' own handler for the identical concurrency hazard.
 */
@Component
public class InternalCallEventsWebSocketHandler extends TextWebSocketHandler {

    private static final Logger log = LoggerFactory.getLogger(InternalCallEventsWebSocketHandler.class);

    private final Set<WebSocketSession> sessions = new CopyOnWriteArraySet<>();

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        sessions.add(session);
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        sessions.remove(session);
    }

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
