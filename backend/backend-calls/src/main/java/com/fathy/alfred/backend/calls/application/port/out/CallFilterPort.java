package com.fathy.alfred.backend.calls.application.port.out;

import com.fathy.alfred.backend.calls.domain.model.CallRecord;

/**
 * Outbound port: lets the settings slice's filtering rules decide whether a call gets persisted,
 * without backend-calls knowing that slice exists. Unlike NewCallObserverPort, exactly one
 * implementation should ever be present (the filter decision is binary, not fan-out), so this is
 * injected as an Optional<CallFilterPort> rather than a List - a missing bean means "no filtering
 * configured", not "zero observers", and CallsService must fail open in that case.
 */
public interface CallFilterPort {

    boolean isAllowed(CallRecord call);
}
