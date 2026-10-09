package com.fathy.alfred.backend.server.application.port.out;

import com.fathy.alfred.backend.server.domain.model.ServerStatus;
import com.fathy.alfred.backend.server.domain.model.UpdateJob;

import java.util.List;
import java.util.Optional;

/** The native install's supervisor (research R6), reached through its token-guarded control API on 127.0.0.1. */
public interface SupervisorPort {

    /** False in Docker mode, or when no supervisor is running. */
    boolean available();

    /**
     * True when something here can attach Alfred's agent: the native supervisor, or for Docker the agent host on the
     * machine (alfred_agent_host.py), which runs no Alfred process and so is not {@link #available()}.
     */
    default boolean attaches() {
        return available();
    }

    /** Re-read .env and restart the children whose command or environment changed; returns their names. */
    List<String> reload();

    void restartBackend();

    void restartProxies();

    /** The supervised processes, as the supervisor sees them. */
    Optional<List<ServerStatus.ProcessStatus>> processes();

    /** The agents it attached to the projects' applications (its last attempt per project), if it runs at all. */
    Optional<List<ServerStatus.AgentAttach>> agents();

    /**
     * Attach Alfred's agent to the JVM on {@code project}'s upstream port with exactly {@code features}
     * (proxy, db, logs, redis). The supervisor finds the JVM itself and answers at once; the outcome arrives as a
     * supervisor event and on {@link #agents()}. {@code force} retries a pid that failed recently.
     *
     * @return false when no supervisor runs (Docker, or stopped)
     */
    boolean attachAgent(String project, List<String> features, boolean force);

    /**
     * Download the installer, verify its sha256 and run it detached from Alfred (which it stops and starts).
     *
     * @return false when the supervisor did not accept it (not running, or an update is already in progress)
     */
    boolean installUpdate(String version, String url, String sha256, long size);

    /** The update the supervisor is working on, if it is running at all. */
    Optional<UpdateJob> updateJob();
}
