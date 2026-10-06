package com.fathy.alfred.backend.logs.application.port.in;

import com.fathy.alfred.backend.logs.domain.model.KeptLogLine;

import java.util.Collection;
import java.util.List;

/**
 * ALFRED's own copies of log lines linked to calls a session cycle holds or that were imported
 * (specs/008-logs-call-link FR-005a, FR-016) - they outlive the log sources' retention.
 */
public interface KeptLogLinesUseCase {

    int MAX_KEPT_PER_CALL = 20_000;

    void keep(List<KeptLogLine> lines);

    /** A call's kept lines, oldest first (at most {@link #MAX_KEPT_PER_CALL}). */
    List<KeptLogLine> kept(String callId);

    int remove(Collection<String> callIds, KeptLogLine.Origin origin);

    /** Calls holding kept lines of this origin (at most {@code limit}). */
    List<String> callsWithKept(KeptLogLine.Origin origin, int limit);
}
