package com.fathy.alfred.backend.triage.application.port.in;

import com.fathy.alfred.backend.triage.domain.model.EndpointHealth;
import com.fathy.alfred.backend.triage.domain.model.ProblemCallsPage;
import com.fathy.alfred.backend.triage.domain.model.ProblemFilter;
import com.fathy.alfred.backend.triage.domain.model.SignalTimeline;

import java.util.Collection;
import java.util.List;

/**
 * Cross-call questions over a set of calls (specs/010-mcp-log-investigation) - the set is decided by the caller (a
 * scope: live, cycles, everything), the answers come from the saved marks alone: no body, statement or line is read.
 */
public interface AnalyseCallsUseCase {

    int MAX_PAGE = 200;
    int MAX_BUCKETS = 1_440;

    /** Calls with an error or warning from HTTP, the database or the logs, counted per signal, most severe first. */
    ProblemCallsPage problemCalls(Collection<String> callIds, ProblemFilter filter, int offset, int limit);

    /** Per endpoint: calls and how many carried each kind of trouble, worst first. */
    List<EndpointHealth> endpoints(Collection<String> callIds, String project, Long fromMs, Long toMs, int limit);

    /** Signals per bucket of start time; the bucket widens so there are at most {@link #MAX_BUCKETS}. */
    SignalTimeline timeline(Collection<String> callIds, String project, Long fromMs, Long toMs, int bucketMinutes);
}
