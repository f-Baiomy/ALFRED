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

    @Override
    public void notifyCycleContentChanged(String cycleId) {
        // Cycle ids are generated ids (letters, digits, '-'), but escape quotes anyway: this is hand-built JSON.
        handler.broadcast("{\"type\":\"cycle-content-changed\",\"cycleId\":\"" + cycleId.replace("\\", "\\\\").replace("\"", "\\\"") + "\"}");
    }
}
