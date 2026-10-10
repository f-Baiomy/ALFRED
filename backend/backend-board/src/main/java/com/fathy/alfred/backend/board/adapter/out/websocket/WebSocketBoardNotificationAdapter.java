package com.fathy.alfred.backend.board.adapter.out.websocket;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.board.application.port.out.BoardNotificationPort;
import com.fathy.alfred.backend.board.domain.model.AgentStatus;
import org.springframework.stereotype.Component;

import java.util.LinkedHashMap;
import java.util.Map;

/** /ws/board messages (contracts/websocket.md): a "board-changed" signal, or the live strip's agent status. */
@Component
public class WebSocketBoardNotificationAdapter implements BoardNotificationPort {

    private final BoardEventsWebSocketHandler handler;
    private final ObjectMapper objectMapper = new ObjectMapper();

    public WebSocketBoardNotificationAdapter(BoardEventsWebSocketHandler handler) {
        this.handler = handler;
    }

    @Override
    public void changed(String project, String cycleId, String cardId, String what) {
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("type", "board-changed");
        if (project != null) {
            event.put("project", project);
        }
        if (cycleId != null) {
            event.put("cycleId", cycleId);
        }
        if (cardId != null) {
            event.put("cardId", cardId);
        }
        event.put("what", what);
        send(event);
    }

    @Override
    public void agentStatus(AgentStatus status) {
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("type", "agent-status");
        event.put("project", status.project());
        if (status.cycleId() != null) {
            event.put("cycleId", status.cycleId());
        }
        event.put("state", status.state().name());
        event.put("callsChecked", status.callsChecked());
        event.put("cardsAdded", status.cardsAdded());
        event.put("lastCheckAt", status.lastCheckAt().toString());
        event.put("updatedAt", status.updatedAt().toString());
        send(event);
    }

    private void send(Map<String, Object> event) {
        try {
            handler.broadcast(objectMapper.writeValueAsString(event));
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Could not serialise a board event", e);
        }
    }
}
