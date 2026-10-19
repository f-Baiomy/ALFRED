package com.fathy.alfred.backend.links.adapter.out.websocket;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.links.application.port.in.PresenceUseCase;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.io.IOException;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArraySet;

/**
 * /ws/links: this Alfred's pages hear about links, offers, streams and requests, and about signals from linked Alfreds
 * (so a page showing their data fetches again - no polling). A page also says here what streamed thing it has open
 * ({@code {"type":"viewing","slug":…,"target":…,"on":true}}) for the owner's presence line (D29); closing the page
 * closes its views.
 */
@Component
public class LinksEventsWebSocketHandler extends TextWebSocketHandler {

    private static final Logger log = LoggerFactory.getLogger(LinksEventsWebSocketHandler.class);
    private static final ObjectMapper JSON = new ObjectMapper();

    private final Set<WebSocketSession> sessions = new CopyOnWriteArraySet<>();
    private final ObjectProvider<PresenceUseCase> presence;

    public LinksEventsWebSocketHandler(ObjectProvider<PresenceUseCase> presence) {
        this.presence = presence;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        sessions.add(session);
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        sessions.remove(session);
        PresenceUseCase p = presence.getIfAvailable();
        if (p != null) {
            p.pageGone(session.getId());
        }
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        try {
            JsonNode m = JSON.readTree(message.getPayload());
            if ("viewing".equals(m.path("type").asText())) {
                PresenceUseCase p = presence.getIfAvailable();
                if (p != null && m.hasNonNull("slug") && m.hasNonNull("target")) {
                    p.viewing(session.getId(), m.path("slug").asText(), m.path("target").asText(), m.path("on").asBoolean(true));
                }
            }
        } catch (IOException | RuntimeException e) {
            log.debug("Ignoring a /ws/links message: {}", e.getMessage());
        }
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
