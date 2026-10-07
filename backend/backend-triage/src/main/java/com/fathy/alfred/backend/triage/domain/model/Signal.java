package com.fathy.alfred.backend.triage.domain.model;

import java.util.ArrayList;
import java.util.List;

/**
 * One kind of trouble on a call (specs/010-mcp-log-investigation, "problem calls"): from HTTP, the database or the
 * application's logs. Errors outrank warnings. {@link #of} says which a call's saved mark carries; a call can carry
 * several and is listed once with all of them.
 */
public enum Signal {
    HTTP_ERROR(true), NO_ANSWER(true), DB_FAILED(true), SUPPLIER_FAILED(true), LOG_ERROR(true), LOG_EXCEPTION(true),
    DB_WARNING(false), LOG_WARNING(false),
    /** A Redis command of the call failed (specs/011-redis-capture). */
    REDIS_FAILED(true),
    /** A Redis read missed a key a recorded call wrote earlier whose TTL had run out (specs/011-redis-capture). */
    CACHE_COLD(false);

    private final boolean error;

    Signal(boolean error) {
        this.error = error;
    }

    public boolean error() {
        return error;
    }

    /**
     * @param minStatus an HTTP status at or over it is an HTTP error (400 by default); an error or a missing answer on a
     *                  completed call is NO_ANSWER
     */
    public static List<Signal> of(CallAttention call, int minStatus) {
        List<Signal> out = new ArrayList<>();
        if (call.error() != null && !call.error().isBlank()) {
            out.add(NO_ANSWER);
        } else if (call.status() != null && call.status() >= minStatus) {
            out.add(HTTP_ERROR);
        }
        if (call.failedStatements() > 0) {
            out.add(DB_FAILED);
        }
        if (call.failingChildren() > 0) {
            out.add(SUPPLIER_FAILED);
        }
        CallSignals s = call.signals();
        if (s.logErrors() > 0) {
            out.add(LOG_ERROR);
        }
        if (s.logExceptions() > 0) {
            out.add(LOG_EXCEPTION);
        }
        if (!s.dbFlags().isEmpty()) {
            out.add(DB_WARNING);
        }
        if (s.logWarnings() > 0) {
            out.add(LOG_WARNING);
        }
        if (s.redisFailed() > 0) {
            out.add(REDIS_FAILED);
        }
        if (s.redisCold() > 0) {
            out.add(CACHE_COLD);
        }
        return out;
    }

    /** 2 when any signal is an error, 1 when only warnings, 0 when none - stored as signal_rank for the index. */
    public static int rank(CallAttention call) {
        List<Signal> signals = of(call, 400);
        return signals.stream().anyMatch(Signal::error) ? 2 : signals.isEmpty() ? 0 : 1;
    }
}
