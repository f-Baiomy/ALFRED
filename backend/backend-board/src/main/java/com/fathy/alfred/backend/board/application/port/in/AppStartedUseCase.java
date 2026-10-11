package com.fathy.alfred.backend.board.application.port.in;

import java.time.Instant;

/**
 * A project's application started again (a new agent process reported, specs/016 FR-8): Fixed cards fixed before it
 * show "new build - ready to re-test". Called by backend-app/boardbridge.
 */
public interface AppStartedUseCase {

    void appStarted(String project, Instant at);
}
