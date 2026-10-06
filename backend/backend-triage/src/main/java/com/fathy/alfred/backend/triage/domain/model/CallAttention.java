package com.fathy.alfred.backend.triage.domain.model;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

/**
 * The saved mark of one call - one row of call_attention, kept current as the call, its supplier calls and its database
 * statements arrive (in any order). {@code priority} is the stored one, for the default threshold
 * ({@link com.fathy.alfred.backend.triage.domain.Priority#STORED_MIN_STATUS}); a read with another threshold re-ranks
 * from the other fields. It is not sent: a {@link TriageEntry} carries the priority for the threshold that was asked.
 *
 * @param startedAt        epoch milliseconds
 * @param state            IN_PROGRESS / COMPLETED / ERROR, or UNKNOWN for a row created by its supplier calls or
 *                         statements before the call itself was reported
 * @param emptyKeys        result-like keys of a successful JSON response that are all empty, else empty
 * @param failingChildren  supplier calls of this call that need attention (at the stored threshold)
 * @param signals          its caught log lines' and database flags' signals (specs/010-mcp-log-investigation)
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record CallAttention(String callId, CallDirection direction, String project, String parentCallId, String method, String url,
                            Integer status, String error, long startedAt, Double durationMs, String state, SoftFailure softFailure,
                            List<String> emptyKeys, int failingChildren, int failedStatements, int swallowedStatements, @JsonIgnore int priority,
                            CallSignals signals) {

    public static final String UNKNOWN = "UNKNOWN";
    public static final String IN_PROGRESS = "IN_PROGRESS";

    public CallAttention {
        emptyKeys = emptyKeys == null ? List.of() : List.copyOf(emptyKeys);
        signals = signals == null ? CallSignals.NONE : signals;
    }

    public CallAttention(String callId, CallDirection direction, String project, String parentCallId, String method, String url,
                         Integer status, String error, long startedAt, Double durationMs, String state, SoftFailure softFailure,
                         List<String> emptyKeys, int failingChildren, int failedStatements, int swallowedStatements, int priority) {
        this(callId, direction, project, parentCallId, method, url, status, error, startedAt, durationMs, state, softFailure, emptyKeys,
                failingChildren, failedStatements, swallowedStatements, priority, CallSignals.NONE);
    }

    public CallAttention withCounts(int children, int failed, int swallowed, int newPriority) {
        return new CallAttention(callId, direction, project, parentCallId, method, url, status, error, startedAt, durationMs, state,
                softFailure, emptyKeys, children, failed, swallowed, newPriority, signals);
    }

    public CallAttention withSignals(CallSignals newSignals) {
        return new CallAttention(callId, direction, project, parentCallId, method, url, status, error, startedAt, durationMs, state,
                softFailure, emptyKeys, failingChildren, failedStatements, swallowedStatements, priority, newSignals);
    }
}
