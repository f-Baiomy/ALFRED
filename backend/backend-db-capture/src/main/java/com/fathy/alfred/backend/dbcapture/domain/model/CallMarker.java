package com.fathy.alfred.backend.dbcapture.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * A non-statement event in a call's sequence. CALL_OPEN (seq 0) is sent the moment the agent starts tracking a
 * call, so a call that ran no statements still has a zero summary ("◆ DB 0", distinct from "not captured").
 * HTTP_OUT is each outbound request the agent tagged with X-Alfred-Parent, at the same seq - so supplier calls'
 * positions are known here without reading another slice. URLs carry no query string.
 *
 * <p>{@code thread} (CALL_OPEN only): the request thread that handled the call - log lines of that thread within the
 * call's window belong to it (specs/008-logs-call-link). Null from agents before that. {@code logs} (CALL_OPEN only):
 * the agent caught this call's log lines (specs/009-agent-log-capture) - its lines come from here, not from log files.
 * {@code logLevel} (CALL_OPEN with logs only): the Log level the agent applied to this call (specs/010).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record CallMarker(String callId, int seq, MarkerType type, String at, String method, String url, String thread, Boolean logs,
                         String logLevel, Boolean redis) {

    /** {@code redis} (CALL_OPEN only): the agent records this call's Redis commands (specs/011-redis-capture). */
    public CallMarker(String callId, int seq, MarkerType type, String at, String method, String url, String thread, Boolean logs,
                      String logLevel) {
        this(callId, seq, type, at, method, url, thread, logs, logLevel, null);
    }

    public CallMarker(String callId, int seq, MarkerType type, String at, String method, String url, String thread, Boolean logs) {
        this(callId, seq, type, at, method, url, thread, logs, null);
    }

    public CallMarker(String callId, int seq, MarkerType type, String at, String method, String url) {
        this(callId, seq, type, at, method, url, null, null, null);
    }

    public CallMarker(String callId, int seq, MarkerType type, String at, String method, String url, String thread) {
        this(callId, seq, type, at, method, url, thread, null, null);
    }
}
