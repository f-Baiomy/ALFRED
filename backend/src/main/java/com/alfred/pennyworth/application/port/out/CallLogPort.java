package com.alfred.pennyworth.application.port.out;

import com.alfred.pennyworth.domain.model.CallRecord;

import java.util.List;

/** Outbound port: how the application core reads logged calls, without knowing they live in a JSON-lines file. */
public interface CallLogPort {

    /** All logged calls, in file order (oldest first). */
    List<CallRecord> readAll();
}
