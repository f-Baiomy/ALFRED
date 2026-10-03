package com.fathy.alfred.backend.logs.application.port.out;

import com.fathy.alfred.backend.logs.domain.model.LogSource;
import com.fathy.alfred.backend.logs.domain.model.LogStructure;

import java.util.List;
import java.util.Optional;

/** Sources and their structure (one structure per source). */
public interface LogSourceStorePort {

    List<LogSource> list();

    Optional<LogSource> get(String id);

    void save(LogSource source);

    void delete(String id);

    Optional<LogStructure> structure(String sourceId);

    void saveStructure(String sourceId, LogStructure structure);

    /** Sources whose structure id equals {@code structureId} (FR-048). */
    List<LogSource> withStructureId(String structureId);

    void addCounts(String sourceId, long lines, long bytes, long unparsed);

    void setCounts(String sourceId, long lines, long bytes);

    /** Bytes on disk of the whole logs store (every source), for the Settings Database table. */
    long storageSizeBytes();
}
