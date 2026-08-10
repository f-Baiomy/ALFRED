package com.fathy.alfred.backend.sessioncycles.adapter.out.websocket;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

/**
 * Reads the same alfred.cors.allowed-origins property CorsConfig (backend-platform) uses -
 * duplicated as a plain @Value rather than a cross-module dependency, since it's one property
 * key, not a shared type or behavior. @EnableWebSocket only needs to appear once anywhere in the
 * context to activate the feature app-wide - it's repeated here anyway so this module's WebSocket
 * registration doesn't silently depend on backend-calls' copy still being present.
 */
@Configuration
@EnableWebSocket
public class SessionCyclesWebSocketConfig implements WebSocketConfigurer {

    private final SessionCycleEventsWebSocketHandler handler;

    @Value("${alfred.cors.allowed-origins:*}")
    private String allowedOrigins;

    public SessionCyclesWebSocketConfig(SessionCycleEventsWebSocketHandler handler) {
        this.handler = handler;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(handler, "/ws/session-cycles").setAllowedOriginPatterns(allowedOrigins.split("\\s*,\\s*"));
    }
}
