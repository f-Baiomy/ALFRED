package com.fathy.alfred.backend.profiles.adapter.out.websocket;

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
 * The Profiles page doesn't send anything meaningful over this socket - it just opens it and
 * listens. Every connected session is tracked here so WebSocketProfileNotificationAdapter can
 * broadcast to all of them; a session that errors on send is assumed dead and dropped rather than
 * retried. Same shape as backend-calls' CallEventsWebSocketHandler, duplicated rather than shared
 * since each slice's WebSocket infrastructure is self-contained.
 */
@Component
public class ProfileEventsWebSocketHandler extends TextWebSocketHandler {

    private static final Logger log = LoggerFactory.getLogger(ProfileEventsWebSocketHandler.class);

    private final Set<WebSocketSession> sessions = new CopyOnWriteArraySet<>();

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        sessions.add(session);
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        sessions.remove(session);
    }

    /** Synchronized per-session (not the whole method) - see backend-calls' CallEventsWebSocketHandler's identical fix/doc for why: sendMessage isn't safe to call concurrently for the same session from two threads. */
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
