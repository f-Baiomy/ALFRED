package com.fathy.alfred.backend.calls.application.port.in;

import com.fathy.alfred.backend.calls.domain.model.CallBaseline;

/** Inbound port for "is this call slow for this endpoint, or is this endpoint just slow?" - see {@link CallBaseline}. */
public interface GetCallBaselineUseCase {

    CallBaseline getBaseline(String url);
}
