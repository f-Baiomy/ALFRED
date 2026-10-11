package com.fathy.alfred.backend.boardbridge;

import com.fathy.alfred.backend.board.application.port.in.AppStartedUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.out.AgentStartedObserverPort;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.time.Instant;

/** A new agent process means the project's app restarted: the board marks Fixed cards "new build - ready to re-test". */
@Component
public class BoardAppStartedAdapter implements AgentStartedObserverPort {

    /** Resolved on first use: the board reads calls and capture, which observe this - eager wiring would be a cycle. */
    private final ObjectProvider<AppStartedUseCase> board;

    public BoardAppStartedAdapter(ObjectProvider<AppStartedUseCase> board) {
        this.board = board;
    }

    @Override
    public void agentStarted(String project, Instant at) {
        board.getObject().appStarted(project, at);
    }
}
