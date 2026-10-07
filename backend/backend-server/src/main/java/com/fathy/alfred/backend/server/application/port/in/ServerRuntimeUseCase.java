package com.fathy.alfred.backend.server.application.port.in;

import java.util.List;

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

    /**
     * The supervisor watches every project's upstream port: this is what it saw - the app's port opened (or its
     * pid changed, an app restart), or closed. Published as a Spring application event by the web adapter, so the
     * slice that owns the attach decision (backend-app's agent bridge) can act without this slice knowing it.
     */
    record AppSeen(String project, int port, long pid, boolean listening) {
    }

    /**
     * Ask the supervisor to attach Alfred's agent to {@code project}'s application (the JVM on its upstream port)
     * with these features. Answers at once; the outcome shows on {@link #status()} and arrives as a server event.
     *
     * @return false in Docker mode or when no supervisor runs - nothing can attach then
     */
    boolean attachAgent(String project, List<String> features, boolean force);
}
