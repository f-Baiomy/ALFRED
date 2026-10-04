package com.fathy.alfred.dbagent.transport;

/** A CALL_OPEN or HTTP_OUT marker (contracts/agent-ingest.md). */
public final class MarkerRecord {
    public final String callId;
    public final int seq;
    public final String type;
    public final String at;
    public final String method;
    public final String url;

    public MarkerRecord(String callId, int seq, String type, String at, String method, String url) {
        this.callId = callId;
        this.seq = seq;
        this.type = type;
        this.at = at;
        this.method = method;
        this.url = url;
    }
}
