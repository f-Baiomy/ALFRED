package com.alfred.pennyworth.application.port.in;

import com.alfred.pennyworth.domain.model.CallRecord;

import java.util.List;

/** Inbound port: what the web layer is allowed to ask for regarding logged calls. */
public interface GetCallsUseCase {

    /** Returns the most recent calls, newest first. {@code limit} is clamped server-side. */
    List<CallRecord> getCalls(int limit);
}
