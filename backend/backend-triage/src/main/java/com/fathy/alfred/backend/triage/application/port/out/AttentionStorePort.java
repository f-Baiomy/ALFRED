package com.fathy.alfred.backend.triage.application.port.out;

import com.fathy.alfred.backend.triage.domain.model.CallAttention;

import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/** call_attention - one row per call, every read through an index. */
public interface AttentionStorePort {

    Optional<CallAttention> find(String callId);

    List<CallAttention> findAll(Collection<String> callIds);

    /** The supplier calls these calls made (by parent_call_id). */
    List<CallAttention> children(Collection<String> parentIds);

    /** Inserts or replaces the whole row. */
    void save(CallAttention row);

    /**
     * Calls with no parent in [since, to], newest first: those at stored priority {@code maxPriority} or better, plus
     * those still IN_PROGRESS since before {@code staleBefore}.
     */
    List<CallAttention> live(String project, long since, long to, int maxPriority, long staleBefore, int limit);

    /** Calls with no parent in [since, to], counted per stored priority. */
    Map<Integer, Integer> counts(String project, long since, long to);

    long size();

    /** Removes the {@code count} oldest rows (by start time) whose id is not in {@code keep}; returns how many went. */
    int deleteOldest(int count, Set<String> keep);

    /** Removes the marks of exactly these calls; returns how many went. */
    int delete(Collection<String> callIds);

    boolean hasMarker(String key);

    void setMarker(String key, String value);
}
