package com.fathy.alfred.backend.links.adapter.out.websocket;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fathy.alfred.backend.links.application.port.out.LinksNotificationPort;
import org.springframework.stereotype.Component;

@Component
public class WebSocketLinksNotificationAdapter implements LinksNotificationPort {

    private static final ObjectMapper JSON = new ObjectMapper();

    private final LinksEventsWebSocketHandler handler;

    public WebSocketLinksNotificationAdapter(LinksEventsWebSocketHandler handler) {
        this.handler = handler;
    }

    @Override
    public void changed(String type, String json) {
        ObjectNode m = JSON.createObjectNode();
        m.put("type", type);
        if (json != null) {
            try {
                m.set("data", JSON.readTree(json));
            } catch (JsonProcessingException e) {
                m.put("data", json);
            }
        }
        handler.broadcast(m.toString());
    }

    @Override
    public void signal(String slug, String channel, String json) {
        ObjectNode m = JSON.createObjectNode();
        m.put("type", "signal");
        m.put("slug", slug);
        m.put("channel", channel);
        try {
            m.set("data", JSON.readTree(json == null ? "{}" : json));
        } catch (JsonProcessingException e) {
            m.putObject("data");
        }
        handler.broadcast(m.toString());
    }
}
