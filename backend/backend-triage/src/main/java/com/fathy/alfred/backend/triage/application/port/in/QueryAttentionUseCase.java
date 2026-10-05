package com.fathy.alfred.backend.triage.application.port.in;

import com.fathy.alfred.backend.triage.domain.model.TriageEntry;

import java.time.Instant;
import java.util.List;
import java.util.Map;

/** Triage's reads - every one served by an index of call_attention. */
public interface QueryAttentionUseCase {

    int MAX_IDS = 500;
    int MAX_LIMIT = 500;

    /**
     * These calls' marks, ranked for {@code minStatus} (300 when null; clamped to 300..600), each with its failing
     * supplier calls. A call with no mark is left out.
     *
     * @throws IllegalArgumentException for more than {@link #MAX_IDS} ids
     */
    Map<String, TriageEntry> forCalls(List<String> callIds, Integer minStatus);

    /**
     * Calls in the window (newest first) at priority {@code maxPriority} or better - inbound calls, and supplier calls
     * no inbound call is known to have made. Supplier calls with a parent come attached to it.
     *
     * @param project null or blank for every project
     */
    List<TriageEntry> live(String project, Instant since, Instant to, int maxPriority, Integer minStatus, int limit);

    /** How many calls of the window are in each priority (1..6), at the stored threshold (300). */
    Map<Integer, Integer> counts(String project, Instant since, Instant to);
}
