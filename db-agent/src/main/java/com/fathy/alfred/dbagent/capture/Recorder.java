package com.fathy.alfred.dbagent.capture;

import com.fathy.alfred.dbagent.transport.StatementSink;

import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.TimeUnit;

/** Owns the pending statements and turns them into records for the sink. */
final class Recorder {

    /** A statement nobody closed and nobody touched for this long is sent as it is (outside calls mostly). */
    static final long STALE_NANOS = TimeUnit.SECONDS.toNanos(3);

    private final StatementSink sink;
    private final ConcurrentLinkedQueue<PendingStatement> pending = new ConcurrentLinkedQueue<>();

    Recorder(StatementSink sink) {
        this.sink = sink;
    }

    void track(PendingStatement p) {
        pending.add(p);
    }

    void chunk(PendingStatement p) {
        synchronized (p) {
            if (p.finished) {
                return;
            }
            sink.statement(p.nextRecord(false));
        }
    }

    void finish(PendingStatement p) {
        if (p == null) {
            return;
        }
        synchronized (p) {
            if (p.finished) {
                return;
            }
            p.finished = true;
            if (p.outcome.partial == null && "ROWS".equals(p.outcome.kind)) {
                p.outcome.partial = Boolean.FALSE;
            }
            sink.statement(p.nextRecord(true));
        }
        pending.remove(p);
    }

    void flushContext(CallContext context) {
        for (PendingStatement p : pending) {
            if (p.context == context) {
                finish(p);
            }
        }
    }

    void flushStale(long nowNanos) {
        for (PendingStatement p : pending) {
            long last;
            synchronized (p) {
                last = p.lastActivityNanos;
            }
            if (nowNanos - last > STALE_NANOS) {
                finish(p);
            }
        }
    }

    int pendingCount() {
        return pending.size();
    }
}
