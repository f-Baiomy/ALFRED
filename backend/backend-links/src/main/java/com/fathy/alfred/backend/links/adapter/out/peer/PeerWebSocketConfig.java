package com.fathy.alfred.backend.links.adapter.out.peer;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

/**
 * Registers /ws/links/peer. A linked Alfred's backend dials it, not a browser, so no origin is required (a Java client
 * sends none); the handshake proves the caller instead.
 */
@Configuration
@EnableWebSocket
public class PeerWebSocketConfig implements WebSocketConfigurer {

    private final PeerSocketHandler handler;

    public PeerWebSocketConfig(PeerSocketHandler handler) {
        this.handler = handler;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(handler, "/ws/links/peer").setAllowedOriginPatterns("*");
    }
}
