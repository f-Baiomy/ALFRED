package com.fathy.alfred.backend.server.application.port.in;

import com.fathy.alfred.backend.server.domain.model.ServerStatus;

/** The Server card (US4): what runs, restarts, and what happens when the backend starts. */
public interface ServerRuntimeUseCase {

    enum Target { BACKEND, PROXIES }

    ServerStatus status();

    /**
     * Asks the supervisor to restart. Waits for a save in progress to finish first.
     *
     * @throws IllegalStateException in Docker mode, or when no supervisor runs
     */
    void restart(Target target);

    /** The backend has started: every saved setting is in effect now (clears the pending list), and history has a baseline. */
    void started();

    /** A supervised process changed state (reported by the supervisor): tell the open pages. */
    void processChanged(String process);
}
