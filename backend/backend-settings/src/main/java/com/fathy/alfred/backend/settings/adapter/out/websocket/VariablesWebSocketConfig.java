package com.fathy.alfred.backend.settings.adapter.out.websocket;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

/**
 * Reads the same alfred.cors.allowed-origins property CorsConfig (backend-platform) and the
 * other slices' WebSocketConfigs use - duplicated as a plain @Value rather than a
 * cross-module dependency, since it's one property key, not a shared type or behavior.
 * Registers at /ws/variables - a new, separate channel from the call-list sockets.
 */
@Configuration
@EnableWebSocket
public class VariablesWebSocketConfig implements WebSocketConfigurer {

    private final VariablesEventsWebSocketHandler handler;

    @Value("${alfred.cors.allowed-origins:*}")
    private String allowedOrigins;

    public VariablesWebSocketConfig(VariablesEventsWebSocketHandler handler) {
        this.handler = handler;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(handler, "/ws/variables").setAllowedOriginPatterns(allowedOrigins.split("\\s*,\\s*"));
    }
}
