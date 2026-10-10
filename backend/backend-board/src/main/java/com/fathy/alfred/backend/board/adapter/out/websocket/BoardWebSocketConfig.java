package com.fathy.alfred.backend.board.adapter.out.websocket;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

/** See backend-profiles' ProfilesWebSocketConfig for why the origins property and @EnableWebSocket are repeated per slice. */
@Configuration
@EnableWebSocket
public class BoardWebSocketConfig implements WebSocketConfigurer {

    private final BoardEventsWebSocketHandler handler;

    @Value("${alfred.cors.allowed-origins:*}")
    private String allowedOrigins;

    public BoardWebSocketConfig(BoardEventsWebSocketHandler handler) {
        this.handler = handler;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(handler, "/ws/board").setAllowedOriginPatterns(allowedOrigins.split("\\s*,\\s*"));
    }
}
