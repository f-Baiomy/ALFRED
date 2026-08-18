package com.fathy.alfred.backend.internalcalls.adapter.out.websocket;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

/**
 * Reads the same alfred.cors.allowed-origins property CorsConfig (backend-platform) and
 * backend-calls' own WebSocketConfig use - duplicated as a plain @Value rather than a
 * cross-module dependency, since it's one property key, not a shared type or behavior. Registers
 * at /ws/internal-calls - a new, separate channel from backend-calls' /ws/calls.
 */
@Configuration
@EnableWebSocket
public class InternalWebSocketConfig implements WebSocketConfigurer {

    private final InternalCallEventsWebSocketHandler handler;

    @Value("${alfred.cors.allowed-origins:*}")
    private String allowedOrigins;

    public InternalWebSocketConfig(InternalCallEventsWebSocketHandler handler) {
        this.handler = handler;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(handler, "/ws/internal-calls").setAllowedOriginPatterns(allowedOrigins.split("\\s*,\\s*"));
    }
}
