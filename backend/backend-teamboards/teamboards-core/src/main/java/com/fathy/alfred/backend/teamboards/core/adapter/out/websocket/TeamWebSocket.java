package com.fathy.alfred.backend.teamboards.core.adapter.out.websocket;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamChangeSignalPort;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArraySet;

/** /ws/teamboards: broadcast-only "something changed" ({type, conn, board?, what, ...}). Pages refetch on it; nothing polls. */
@Configuration
@EnableWebSocket
public class TeamWebSocket extends TextWebSocketHandler implements WebSocketConfigurer, TeamChangeSignalPort {

    private static final Logger log = LoggerFactory.getLogger(TeamWebSocket.class);

    private final Set<WebSocketSession> sessions = new CopyOnWriteArraySet<>();
    private final ObjectMapper json = new ObjectMapper();

    @Value("${alfred.cors.allowed-origins:*}")
    private String allowedOrigins = "*";

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(this, "/ws/teamboards").setAllowedOriginPatterns(allowedOrigins.split("\\s*,\\s*"));
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        sessions.add(session);
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        sessions.remove(session);
    }

    @Override
    public void changed(String conn, String what) {
        board(null, conn, what, Map.of());
    }

    @Override
    public void board(String boardId, String conn, String what, Map<String, Object> extra) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("type", "team-changed");
        body.put("conn", conn);
        if (boardId != null) {
            body.put("board", boardId);
        }
        body.put("what", what);
        if (extra != null) {
            extra.forEach(body::putIfAbsent);
        }
        send(body);
    }

    private void send(Map<String, Object> body) {
        TextMessage message;
        try {
            message = new TextMessage(json.writeValueAsString(body));
        } catch (IOException e) {
            return;
        }
        for (WebSocketSession s : sessions) {
            try {
                synchronized (s) {
                    if (s.isOpen()) {
                        s.sendMessage(message);
                    }
                }
            } catch (IOException | IllegalStateException e) {
                log.warn("Dropping /ws/teamboards session {}: {}", s.getId(), e.getMessage());
                sessions.remove(s);
            }
        }
    }
}
