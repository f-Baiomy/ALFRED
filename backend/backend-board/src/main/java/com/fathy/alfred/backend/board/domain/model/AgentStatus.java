package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;

/** What Claude is doing on a project's board, for the live strip. Held in memory only. */
public record AgentStatus(String project, String cycleId, State state, int callsChecked, int cardsAdded, Instant lastCheckAt,
                          Instant updatedAt) {

    public enum State { WATCHING, PAUSED, STOPPED }

    public AgentStatus withState(State newState, Instant at) {
        return new AgentStatus(project, cycleId, newState, callsChecked, cardsAdded, lastCheckAt, at);
    }
}
