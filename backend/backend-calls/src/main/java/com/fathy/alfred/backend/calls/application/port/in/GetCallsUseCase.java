package com.fathy.alfred.backend.calls.application.port.in;

import java.util.List;

import com.fathy.alfred.backend.calls.domain.model.CallSummary;
import com.fathy.alfred.backend.calls.domain.model.CallsPage;
import com.fathy.alfred.backend.calls.domain.model.CallsQuery;

/** Inbound port: what the web layer is allowed to ask for regarding logged calls. */
public interface GetCallsUseCase {

    /** Filters, sorts, and paginates server-side - {@code query}'s offset/limit are clamped server-side. */
    CallsPage getCalls(CallsQuery query);

    /**
     * The outbound calls one inbound call made, by the exact parent link the db-agent's X-Alfred-Parent header
     * recorded (docs/db-capture.md), in the order they were made - regardless of any list filter or page.
     */
    List<CallSummary> getChildren(String parentCallId);
}
