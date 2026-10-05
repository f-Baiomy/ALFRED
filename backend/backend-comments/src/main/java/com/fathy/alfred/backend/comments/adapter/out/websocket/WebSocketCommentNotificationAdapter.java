package com.fathy.alfred.backend.comments.adapter.out.websocket;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.comments.application.port.out.CommentNotificationPort;
import org.springframework.stereotype.Component;

import java.util.Map;

@Component
public class WebSocketCommentNotificationAdapter implements CommentNotificationPort {

    private final CommentEventsWebSocketHandler handler;
    private final ObjectMapper objectMapper = new ObjectMapper();

    public WebSocketCommentNotificationAdapter(CommentEventsWebSocketHandler handler) {
        this.handler = handler;
    }

    @Override
    public void notifyCommentsChanged(String callId) {
        try {
            handler.broadcast(objectMapper.writeValueAsString(Map.of("type", "comments-changed", "callId", callId)));
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Could not serialise a comments-changed event", e);
        }
    }
}
