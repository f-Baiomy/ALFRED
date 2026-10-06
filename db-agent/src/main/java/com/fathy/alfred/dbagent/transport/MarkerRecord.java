package com.fathy.alfred.dbagent.transport;

/** A CALL_OPEN or HTTP_OUT marker (contracts/agent-ingest.md). */
public final class MarkerRecord {
    public final String callId;
    public final int seq;
    public final String type;
    public final String at;
    public final String method;
    public final String url;
    /** CALL_OPEN only: the request thread's name - what log lines are matched by (specs/008-logs-call-link). */
    public final String thread;
    /** CALL_OPEN only: the agent catches this call's log lines (log=1 - specs/009-agent-log-capture). */
    public final boolean logs;

    public MarkerRecord(String callId, int seq, String type, String at, String method, String url) {
        this(callId, seq, type, at, method, url, null);
    }

    public MarkerRecord(String callId, int seq, String type, String at, String method, String url, String thread) {
        this(callId, seq, type, at, method, url, thread, false);
    }

    public MarkerRecord(String callId, int seq, String type, String at, String method, String url, String thread, boolean logs) {
        this.logs = logs;
        this.callId = callId;
        this.seq = seq;
        this.type = type;
        this.at = at;
        this.method = method;
        this.url = url;
        this.thread = thread;
    }
}
