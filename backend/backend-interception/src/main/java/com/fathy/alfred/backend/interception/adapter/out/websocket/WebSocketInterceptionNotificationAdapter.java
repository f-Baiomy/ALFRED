package com.fathy.alfred.backend.interception.adapter.out.websocket;

import com.fathy.alfred.backend.interception.application.port.out.InterceptionNotificationPort;
import org.springframework.stereotype.Component;

/**
 * Two payload-free events on one socket. They are distinct rather than a single
 * "interception-changed" because the UI reacts differently: a rules change refetches a list, while
 * a paused change has a countdown attached and drives the badge in the tab bar.
 */
@Component
public class WebSocketInterceptionNotificationAdapter implements InterceptionNotificationPort {

    private static final String RULES_CHANGED = "{\"type\":\"interception-rules-changed\"}";
    private static final String PAUSED_CHANGED = "{\"type\":\"interception-paused-changed\"}";

    private final InterceptionEventsWebSocketHandler handler;

    public WebSocketInterceptionNotificationAdapter(InterceptionEventsWebSocketHandler handler) {
        this.handler = handler;
    }

    @Override
    public void rulesChanged() {
        handler.broadcast(RULES_CHANGED);
    }

    @Override
    public void pausedCallsChanged() {
        handler.broadcast(PAUSED_CHANGED);
    }
}
