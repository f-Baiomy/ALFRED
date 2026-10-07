package com.fathy.alfred.backend.server.adapter.out.websocket;

import com.fathy.alfred.backend.server.application.port.out.ServerEventsPort;

/** Sends {"type":"server-status-changed","what":"..."} on /ws/server. No values, ever - clients re-fetch. */
public class WebSocketServerEventsAdapter implements ServerEventsPort {

    private final ServerEventsWebSocketHandler handler;

    public WebSocketServerEventsAdapter(ServerEventsWebSocketHandler handler) {
        this.handler = handler;
    }

    @Override
    public void serverChanged(String what) {
        String safe = what == null ? "" : what.replaceAll("[^A-Za-z0-9_-]", "");
        handler.broadcast("{\"type\":\"server-status-changed\",\"what\":\"" + safe + "\"}");
    }
}
