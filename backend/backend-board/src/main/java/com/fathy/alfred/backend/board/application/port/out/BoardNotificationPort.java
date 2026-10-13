package com.fathy.alfred.backend.board.application.port.out;

import com.fathy.alfred.backend.board.domain.model.AgentStatus;
import com.fathy.alfred.backend.board.domain.model.LiveWork;

/** The "board changed" signal on /ws/board (contracts/websocket.md): clients re-fetch what they show. */
public interface BoardNotificationPort {

    /** {@code what}: card, activity, brief, specs, checklist, deleted. cycleId and cardId may be null. */
    void changed(String project, String cycleId, String cardId, String what);

    void agentStatus(AgentStatus status);

    /** /alfred-live's work on a card changed (a step, the draft, the end, a Stop). */
    default void liveWork(LiveWork work) {
    }

    /** /alfred-live's runner started ({@code host} where it runs) or stopped ({@code host} null) on a project's board. */
    default void liveRunner(String project, String host) {
    }
}
