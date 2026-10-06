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
    /** Tables whose index list this call has already sent (Index check: once per table per call). */
    private final java.util.Set<String> indexedTables = java.util.concurrent.ConcurrentHashMap.newKeySet();

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

    /**
     * The call id to tag the request's log lines with: set only when the header says {@code log=1} (the project's
     * log-linking switch - specs/008-logs-call-link), whatever {@code db} says. Null otherwise.
     */
    public static String logTagId(String header) {
        if (header == null || header.isEmpty()) {
            return null;
        }
        String id = null;
        boolean log = false;
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
            } else if (key.equals("log")) {
                log = value.equals("1");
            }
        }
        return log && id != null && !id.isEmpty() ? id : null;
    }

    /** True the first time this call asks about {@code table}. */
    boolean firstIndexLookup(String table) {
        return indexedTables.add(table.toLowerCase(java.util.Locale.ROOT));
    }
}
