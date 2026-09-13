package com.fathy.alfred.backend.internalcalls.application.port.in;

import com.fathy.alfred.backend.internalcalls.domain.model.CallBaseline;

/** Mirrors backend-calls' use case of the same name, for inbound traffic. */
public interface GetCallBaselineUseCase {

    CallBaseline getBaseline(String url);
}
