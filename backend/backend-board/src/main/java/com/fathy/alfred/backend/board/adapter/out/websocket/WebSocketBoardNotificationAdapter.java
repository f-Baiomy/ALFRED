package com.fathy.alfred.backend.board.adapter.out.websocket;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.board.application.port.out.BoardNotificationPort;
import com.fathy.alfred.backend.board.domain.model.AgentStatus;
import com.fathy.alfred.backend.board.domain.model.LiveWork;
import com.fathy.alfred.backend.board.domain.model.SkillRun;
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
        if (status.step() != null) {
            event.put("step", status.step());
        }
        send(event);
    }

    @Override
    public void liveRunner(String project, String host, String kind) {
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("type", "live-runner");
        event.put("project", project);
        event.put("host", host);
        event.put("kind", kind);
        send(event);
    }

    @Override
    public void liveWork(LiveWork work) {
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("type", "live-work");
        // By hand: this mapper has no java.time module, and the client wants ISO strings anyway.
        Map<String, Object> w = new LinkedHashMap<>();
        w.put("id", work.id());
        w.put("project", work.project());
        w.put("cardNumber", work.cardNumber());
        w.put("head", work.head());
        w.put("steps", work.steps());
        w.put("draft", work.draft());
        w.put("state", work.state().name());
        w.put("outcome", work.outcome());
        w.put("stop", work.stop());
        w.put("startedAt", work.startedAt().toString());
        w.put("updatedAt", work.updatedAt().toString());
        if (work.chatMessageId() != null) {
            w.put("chatMessageId", work.chatMessageId());
        }
        if (work.usage() != null) {
            w.put("usage", work.usage());
        }
        event.put("work", w);
        send(event);
    }

    @Override
    public void cycleChat(String project, String cycleId) {
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("type", "cycle-chat");
        event.put("project", project);
        event.put("cycleId", cycleId);
        send(event);
    }

    /** A signal, not the message: the panel re-reads the chat (GET /board/chats/...) - message text never goes over the socket. */
    @Override
    public void chatChanged(String project, String scope, Long id) {
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("type", "chat-changed");
        event.put("project", project);
        event.put("scope", scope);
        if (id != null) {
            event.put("id", id);
        }
        send(event);
    }

    /** A signal, not the run: the board re-reads its runs (GET /board/skill-runs) - the prompt never goes over the socket. */
    @Override
    public void skillRun(SkillRun run) {
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("type", "skill-run");
        event.put("project", run.project());
        event.put("id", run.id());
        if (run.cardNumber() != null) {
            event.put("cardNumber", run.cardNumber());
        }
        event.put("state", run.state().name());
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
