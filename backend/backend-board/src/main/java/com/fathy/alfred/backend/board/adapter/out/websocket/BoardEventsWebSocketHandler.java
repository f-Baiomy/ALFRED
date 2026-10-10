package com.fathy.alfred.backend.board.adapter.out.websocket;

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

/** Clients only listen on this socket (contracts/websocket.md). Same shape as triage's handler (each slice has its own). */
@Component
public class BoardEventsWebSocketHandler extends TextWebSocketHandler {

    private static final Logger log = LoggerFactory.getLogger(BoardEventsWebSocketHandler.class);

    private final Set<WebSocketSession> sessions = new CopyOnWriteArraySet<>();

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        sessions.add(session);
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        sessions.remove(session);
    }

    /** Synchronized per session: sendMessage is not safe to call concurrently for one session. */
    public void broadcast(String json) {
        if (sessions.isEmpty()) {
            return;
        }
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
