package com.fathy.alfred.backend.calls.application.port.in;

import com.fathy.alfred.backend.calls.domain.model.CallsPage;
import com.fathy.alfred.backend.calls.domain.model.CallsQuery;

/** Inbound port: what the web layer is allowed to ask for regarding logged calls. */
public interface GetCallsUseCase {

    /** Filters, sorts, and paginates server-side - {@code query}'s offset/limit are clamped server-side. */
    CallsPage getCalls(CallsQuery query);
}
