package com.fathy.alfred.backend.dbcapture.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * What a transaction cost beyond its statements - connection checkout, begin (auto-commit off), the commit/rollback
 * call and handing the connection back - and how it ended ({@code via}: JDBC or JTA). Microseconds; any may be null
 * (not observed, or an agent that predates this).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record TxLifecycle(String via, Long acquireMicros, Long beginMicros, Long commitMicros, Long closeMicros) {

    /** The part of the transaction spent outside its statements, as far as observed. */
    public long overheadMicros() {
        return n(acquireMicros) + n(beginMicros) + n(commitMicros) + n(closeMicros);
    }

    private static long n(Long v) {
        return v == null ? 0 : v;
    }
}
