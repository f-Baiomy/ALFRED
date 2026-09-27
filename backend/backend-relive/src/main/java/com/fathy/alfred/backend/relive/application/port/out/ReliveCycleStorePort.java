package com.fathy.alfred.backend.relive.application.port.out;

import com.fathy.alfred.backend.relive.domain.model.CycleVersion;
import com.fathy.alfred.backend.relive.domain.model.ReliveCycle;
import com.fathy.alfred.backend.relive.domain.model.ReliveCycleSummary;

import java.util.List;
import java.util.Optional;

/** Outbound port: cycle definitions and their saved versions, without the application core
 *  knowing it's SQLite today. */
public interface ReliveCycleStorePort {

    /** Newest first, without {@code steps}/{@code variables}/{@code cycleRules} bodies (constitution II). */
    List<ReliveCycleSummary> listSummaries();

    Optional<ReliveCycle> findById(String id);

    boolean existsById(String id);

    /** Upsert - saves a new cycle or overwrites an existing one with the same id. */
    ReliveCycle save(ReliveCycle cycle);

    boolean deleteById(String id);

    /** Appends a version snapshot, then trims to the newest {@code keep} (FR-007c). */
    void saveVersion(CycleVersion version, int keep);

    /** Newest first, without {@code definition}. */
    List<CycleVersion> listVersions(String cycleId);

    Optional<CycleVersion> getVersion(String cycleId, int version);

    void pruneVersions(String cycleId, int keep);
}
