package com.fathy.alfred.backend.sessioncycles.adapter.out.websocket;

import com.fathy.alfred.backend.sessioncycles.application.port.out.SessionCycleNotificationPort;
import org.springframework.stereotype.Component;

@Component
public class WebSocketSessionCycleNotificationAdapter implements SessionCycleNotificationPort {

    private static final String CHANGED_EVENT = "{\"type\":\"session-cycles-changed\"}";

    private final SessionCycleEventsWebSocketHandler handler;

    public WebSocketSessionCycleNotificationAdapter(SessionCycleEventsWebSocketHandler handler) {
        this.handler = handler;
    }

    @Override
    public void notifySessionCyclesChanged() {
        handler.broadcast(CHANGED_EVENT);
    }
}
