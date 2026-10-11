package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.AgentStatus;

import java.util.Optional;

/** The live strip: what Claude watches on a project's board. In memory; STOPPED once not updated for 10 minutes. */
public interface AgentStatusUseCase {

    Optional<AgentStatus> status(String project);

    AgentStatus update(String project, String cycleId, AgentStatus.State state, int callsChecked, int cardsAdded);

    /** With the line the live strip shows of what Claude is doing now ("reviewing ODY-482 · 34/120 calls"). */
    AgentStatus update(String project, String cycleId, AgentStatus.State state, int callsChecked, int cardsAdded, String step);

    Optional<AgentStatus> setState(String project, AgentStatus.State state);

    boolean paused(String project);
}
