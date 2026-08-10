package com.fathy.alfred.backend.profiles.adapter.out.websocket;

import com.fathy.alfred.backend.profiles.application.port.out.ProfileNotificationPort;
import org.springframework.stereotype.Component;

@Component
public class WebSocketProfileNotificationAdapter implements ProfileNotificationPort {

    private static final String CHANGED_EVENT = "{\"type\":\"profiles-changed\"}";

    private final ProfileEventsWebSocketHandler handler;

    public WebSocketProfileNotificationAdapter(ProfileEventsWebSocketHandler handler) {
        this.handler = handler;
    }

    @Override
    public void notifyProfilesChanged() {
        handler.broadcast(CHANGED_EVENT);
    }
}
