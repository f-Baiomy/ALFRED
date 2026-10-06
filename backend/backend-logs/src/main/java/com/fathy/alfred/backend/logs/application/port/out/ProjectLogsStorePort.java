package com.fathy.alfred.backend.logs.application.port.out;

import com.fathy.alfred.backend.logs.domain.model.KeptLogLine;
import com.fathy.alfred.backend.logs.domain.model.ProjectLogSettings;

import java.util.Collection;
import java.util.List;
import java.util.Optional;

/** Project log settings and kept lines (specs/008-logs-call-link) - both in logs.db. */
public interface ProjectLogsStorePort {

    Optional<ProjectLogSettings> settings(String project);

    void saveSettings(ProjectLogSettings settings);

    /** Every project's saved settings. */
    List<ProjectLogSettings> allSettings();

    /** Inserts or replaces by (call id, source id, line id). */
    void keep(List<KeptLogLine> lines);

    /** A call's kept lines, oldest first, at most {@code limit}. */
    List<KeptLogLine> kept(String callId, int limit);

    /** Removes the kept lines of these calls (of either origin when {@code origin} is null). */
    int removeKept(Collection<String> callIds, KeptLogLine.Origin origin);

    /** Calls holding kept lines of this origin (at most {@code limit}) - to drop those no cycle holds any more. */
    List<String> callsWithKept(KeptLogLine.Origin origin, int limit);
}
