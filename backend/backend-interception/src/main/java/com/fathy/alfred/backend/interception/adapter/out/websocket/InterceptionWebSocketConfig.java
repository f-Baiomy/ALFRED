package com.fathy.alfred.backend.interception.adapter.out.websocket;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

/**
 * Named InterceptionWebSocketConfig rather than WebSocketConfig deliberately: Spring names a
 * @Configuration bean from its SIMPLE class name regardless of package, so a second
 * "WebSocketConfig" anywhere in the context collides with backend-calls' at startup
 * (ConflictingBeanDefinitionException) - which is exactly how backend-session-cycles and
 * backend-profiles ended up with prefixed names. See docs/frontend-architecture.md.
 */
@Configuration
@EnableWebSocket
public class InterceptionWebSocketConfig implements WebSocketConfigurer {

    private final InterceptionEventsWebSocketHandler handler;

    @Value("${alfred.cors.allowed-origins:*}")
    private String allowedOrigins;

    public InterceptionWebSocketConfig(InterceptionEventsWebSocketHandler handler) {
        this.handler = handler;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(handler, "/ws/interception").setAllowedOriginPatterns(allowedOrigins.split("\\s*,\\s*"));
    }
}
