package com.fathy.alfred.dbagent.capture;

import java.util.concurrent.atomic.AtomicInteger;

/**
 * The inbound call a thread is working for, opened from the X-Alfred-Call header the reverse proxy adds
 * ({@code id=<callId>; db=1[; run=<runId>/<stepKey>]}). {@link #nextSeq} is the one counter statements and outbound
 * HTTP share, so their order is exact whatever the clocks say. Seq 0 is the CALL_OPEN marker.
 */
public final class CallContext {

    public static final String HEADER = "X-Alfred-Call";

    final String callId;
    final String runTag;
    final long startNanos;
    private final AtomicInteger seq = new AtomicInteger();
    private final AtomicInteger tx = new AtomicInteger();

    CallContext(String callId, String runTag, long startNanos) {
        this.callId = callId;
        this.runTag = runTag;
        this.startNanos = startNanos;
    }

    public String callId() {
        return callId;
    }

    public String runTag() {
        return runTag;
    }

    public int nextSeq() {
        return seq.incrementAndGet();
    }

    String nextTxId() {
        return "tx-" + tx.incrementAndGet();
    }

    long offsetMicros(long nanos) {
        return Math.max(0, (nanos - startNanos) / 1000);
    }

    /**
     * Parses the header; null unless it names a call AND says {@code db=1}. Unknown parts are ignored so a newer proxy
     * can add more.
     */
    public static CallContext fromHeader(String header, long nowNanos) {
        if (header == null || header.isEmpty()) {
            return null;
        }
        String id = null;
        String run = null;
        boolean db = false;
        for (String part : header.split(";")) {
            String p = part.trim();
            int eq = p.indexOf('=');
            if (eq <= 0) {
                continue;
            }
            String key = p.substring(0, eq).trim();
            String value = p.substring(eq + 1).trim();
            if (key.equals("id")) {
                id = value;
            } else if (key.equals("db")) {
                db = value.equals("1");
            } else if (key.equals("run")) {
                run = value;
            }
        }
        if (id == null || id.isEmpty() || !db) {
            return null;
        }
        return new CallContext(id, run == null || run.isEmpty() ? null : run, nowNanos);
    }
}
