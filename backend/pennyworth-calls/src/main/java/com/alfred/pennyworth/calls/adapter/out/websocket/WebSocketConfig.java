package com.alfred.pennyworth.calls.adapter.out.websocket;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

/**
 * Reads the same alfred.cors.allowed-origins property CorsConfig (pennyworth-platform) uses -
 * duplicated as a plain @Value rather than a cross-module dependency, since it's one property
 * key, not a shared type or behavior.
 */
@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {

    private final CallEventsWebSocketHandler handler;

    @Value("${alfred.cors.allowed-origins:*}")
    private String allowedOrigins;

    public WebSocketConfig(CallEventsWebSocketHandler handler) {
        this.handler = handler;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(handler, "/ws/calls").setAllowedOriginPatterns(allowedOrigins.split("\\s*,\\s*"));
    }
}
