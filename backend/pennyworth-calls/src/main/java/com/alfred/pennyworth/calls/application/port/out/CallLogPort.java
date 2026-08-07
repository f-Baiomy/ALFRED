package com.alfred.pennyworth.calls.application.port.out;

import com.alfred.pennyworth.calls.domain.model.CallRecord;

import java.util.List;

/** Outbound port: how the application core reads and persists logged calls, without knowing they live in a JSON-lines file. */
public interface CallLogPort {

    /** All logged calls, in file order (oldest first). */
    List<CallRecord> readAll();

    /** Persists one newly-received call (appended, not upserted - each call is its own record). */
    void save(CallRecord call);
}
