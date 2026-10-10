package com.fathy.alfred.backend.board.application.port.out;

import com.fathy.alfred.backend.board.domain.model.AgentStatus;

/** The "board changed" signal on /ws/board (contracts/websocket.md): clients re-fetch what they show. */
public interface BoardNotificationPort {

    /** {@code what}: card, activity, brief, specs, checklist, deleted. cycleId and cardId may be null. */
    void changed(String project, String cycleId, String cardId, String what);

    void agentStatus(AgentStatus status);
}
