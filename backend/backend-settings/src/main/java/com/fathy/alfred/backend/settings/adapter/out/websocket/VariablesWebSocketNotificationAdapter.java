package com.fathy.alfred.backend.settings.adapter.out.websocket;

import com.fathy.alfred.backend.settings.application.port.out.VariablesChangedNotificationPort;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Port implementation behind {@link VariablesChangedNotificationPort}: one payload-free event,
 * dashboard refetches. Mirrors backend-internal-calls' InternalWebSocketCallNotificationAdapter.
 */
@Component
public class VariablesWebSocketNotificationAdapter implements VariablesChangedNotificationPort {

    private static final Logger log = LoggerFactory.getLogger(VariablesWebSocketNotificationAdapter.class);

    private static final String VARIABLES_CHANGED_EVENT = "{\"type\":\"variables-changed\"}";

    private final VariablesEventsWebSocketHandler handler;

    public VariablesWebSocketNotificationAdapter(VariablesEventsWebSocketHandler handler) {
        this.handler = handler;
    }

    @Override
    public void notifyVariablesChanged() {
        try {
            handler.broadcast(VARIABLES_CHANGED_EVENT);
        } catch (Exception e) {
            log.warn("Failed to broadcast variables-changed event: {}", e.getMessage());
        }
    }
}
