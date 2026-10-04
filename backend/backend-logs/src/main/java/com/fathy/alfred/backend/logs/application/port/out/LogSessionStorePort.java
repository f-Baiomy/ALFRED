package com.fathy.alfred.backend.logs.application.port.out;

import com.fathy.alfred.backend.logs.domain.model.LogSession;

import java.util.List;
import java.util.Optional;

/** Recorded sessions of a live log. */
public interface LogSessionStorePort {

    void save(LogSession session);

    Optional<LogSession> get(String id);

    /** Newest first. */
    List<LogSession> bySource(String sourceId);

    void delete(String id);

    void deleteSource(String sourceId);
}
