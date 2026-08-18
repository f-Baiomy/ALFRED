package com.fathy.alfred.backend.internalcalls.application.port.in;

import com.fathy.alfred.backend.internalcalls.domain.model.CallsPage;
import com.fathy.alfred.backend.internalcalls.domain.model.CallsQuery;

/** Inbound port: what the web layer is allowed to ask for regarding logged internal calls. */
public interface GetCallsUseCase {

    /** Filters, sorts, and paginates server-side - {@code query}'s offset/limit are clamped server-side. */
    CallsPage getCalls(CallsQuery query);
}
