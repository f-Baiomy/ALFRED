package com.fathy.alfred.dbagent.capture;

import com.fathy.alfred.dbagent.transport.Outcome;
import com.fathy.alfred.dbagent.transport.StatementRecord;
import com.fathy.alfred.dbagent.transport.Value;

import java.util.ArrayList;
import java.util.List;

/**
 * A statement that ran and is still collecting what it produced - the rows the application reads, its generated keys,
 * its OUT parameters - until it is finished (result set or statement closed, next execute, end of the call, or idle).
 * Long results leave in 500-row chunks under the same sid. Synchronized: async threads and the sender's stale-flush
 * may touch it.
 */
final class PendingStatement {

    static final int CHUNK_ROWS = 500;

    final StatementRecord base;
    final CallContext context;
    final long startNanos;
    final Outcome outcome;
    final List<List<Value>> rows = new ArrayList<>();
    int rowsSent;
    long rowsRead;
    boolean firstSent;
    boolean finished;
    long lastActivityNanos;

    PendingStatement(StatementRecord base, CallContext context, long startNanos, Outcome outcome) {
        this.base = base;
        this.context = context;
        this.startNanos = startNanos;
        this.outcome = outcome;
        this.lastActivityNanos = startNanos;
    }

    /** A chunk or the final record: the base plus the rows collected since the last chunk. */
    synchronized StatementRecord nextRecord(boolean last) {
        StatementRecord r = firstSent ? continuation() : copyBase();
        Outcome o = outcome.copy();
        if (o.columns != null || "ROWS".equals(o.kind)) {
            o.rowsRead = rowsRead;
            if (!last) {
                o.partial = null;
            }
        }
        r.outcome = o;
        r.rows = rows.isEmpty() && firstSent && !last ? null : new ArrayList<>(rows);
        r.rowsFrom = rowsSent;
        rowsSent += rows.size();
        rows.clear();
        firstSent = true;
        return r;
    }

    private StatementRecord copyBase() {
        StatementRecord r = new StatementRecord();
        r.sid = base.sid;
        r.callId = base.callId;
        r.runTag = base.runTag;
        r.thread = base.thread;
        r.seq = base.seq;
        r.kind = base.kind;
        r.sql = base.sql;
        r.fingerprint = base.fingerprint;
        r.table = base.table;
        r.params = base.params;
        r.beforeImageRows = base.beforeImageRows;
        r.beforeImage = base.beforeImage;
        r.startedAt = base.startedAt;
        r.durationMicros = base.durationMicros;
        r.offsetMicros = base.offsetMicros;
        r.txId = base.txId;
        r.connectionId = base.connectionId;
        r.codeLocation = base.codeLocation;
        r.callers = base.callers;
        r.origin = base.origin;
        r.dataSource = base.dataSource;
        r.cascadesTo = base.cascadesTo;
        return r;
    }

    /** Continuation chunks repeat what the backend needs to find and update the statement. */
    private StatementRecord continuation() {
        StatementRecord r = copyBase();
        r.params = null;
        r.beforeImageRows = null;
        return r;
    }
}
