package com.fathy.alfred.backend.server.application.port.out;

import com.fathy.alfred.backend.server.domain.model.ServerStatus;

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
}
