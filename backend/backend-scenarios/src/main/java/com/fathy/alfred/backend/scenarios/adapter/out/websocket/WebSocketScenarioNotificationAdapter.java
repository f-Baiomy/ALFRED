package com.fathy.alfred.backend.scenarios.adapter.out.websocket;

import com.fathy.alfred.backend.scenarios.application.port.out.ScenarioNotificationPort;
import org.springframework.stereotype.Component;

@Component
public class WebSocketScenarioNotificationAdapter implements ScenarioNotificationPort {

    private static final String CHANGED_EVENT = "{\"type\":\"scenarios-changed\"}";

    private final ScenarioEventsWebSocketHandler handler;

    public WebSocketScenarioNotificationAdapter(ScenarioEventsWebSocketHandler handler) {
        this.handler = handler;
    }

    @Override
    public void notifyScenariosChanged() {
        handler.broadcast(CHANGED_EVENT);
    }
}
