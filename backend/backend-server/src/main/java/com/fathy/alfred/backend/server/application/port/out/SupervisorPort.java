package com.fathy.alfred.backend.server.application.port.out;

import com.fathy.alfred.backend.server.domain.model.ServerStatus;
import com.fathy.alfred.backend.server.domain.model.UpdateJob;

import java.util.List;
import java.util.Optional;

/** The native install's supervisor (research R6), reached through its token-guarded control API on 127.0.0.1. */
public interface SupervisorPort {

    /** False in Docker mode, or when no supervisor is running. */
    boolean available();

    /** Re-read .env and restart the children whose command or environment changed; returns their names. */
    List<String> reload();

    void restartBackend();

    void restartProxies();

    /** The supervised processes, as the supervisor sees them. */
    Optional<List<ServerStatus.ProcessStatus>> processes();

    /**
     * Download the installer, verify its sha256 and run it detached from Alfred (which it stops and starts).
     *
     * @return false when the supervisor did not accept it (not running, or an update is already in progress)
     */
    boolean installUpdate(String version, String url, String sha256, long size);

    /** The update the supervisor is working on, if it is running at all. */
    Optional<UpdateJob> updateJob();
}
