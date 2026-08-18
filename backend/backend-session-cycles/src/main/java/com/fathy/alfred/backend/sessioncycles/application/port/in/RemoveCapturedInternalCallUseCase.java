package com.fathy.alfred.backend.sessioncycles.application.port.in;

/** Mirrors RemoveCapturedCallUseCase for the internal-calls path. */
public interface RemoveCapturedInternalCallUseCase {

    /** @return true if a captured internal call with this id existed in this cycle and was removed. */
    boolean removeCall(String cycleId, String callId);
}
