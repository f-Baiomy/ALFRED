package com.fathy.alfred.backend.board.application.port.out;

import com.fathy.alfred.backend.board.domain.model.AgentStatus;
import com.fathy.alfred.backend.board.domain.model.LiveWork;
import com.fathy.alfred.backend.board.domain.model.SkillRun;

/** The "board changed" signal on /ws/board (contracts/websocket.md): clients re-fetch what they show. */
public interface BoardNotificationPort {

    /** {@code what}: card, activity, brief, specs, checklist, deleted. cycleId and cardId may be null. */
    void changed(String project, String cycleId, String cardId, String what);

    void agentStatus(AgentStatus status);

    /** /alfred-live's work on a card changed (a step, the draft, the end, a Stop). */
    default void liveWork(LiveWork work) {
    }

    /**
     * A runner started ({@code host} where it runs) or stopped ({@code host} null) on a project's board; {@code kind} is
     * "live" (/alfred-live) or "listen" (/alfred-listen).
     */
    default void liveRunner(String project, String host, String kind) {
    }

    /** The chat handling a cycle started, stopped, or its chat closed (its runner still beating). */
    default void cycleChat(String project, String cycleId) {
    }

    /**
     * A board chat changed (specs/022): a message posted, edited, cancelled, taken, answered or compacted. {@code scope} is
     * "project" or the cycle id, {@code id} the message (null when the change was not one message, e.g. settings).
     */
    default void chatChanged(String project, String scope, Long id) {
    }

    /** A skill run started from the board was queued, taken, reported, stopped or ended. */
    default void skillRun(SkillRun run) {
    }
}
