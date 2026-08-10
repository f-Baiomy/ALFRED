package com.fathy.alfred.backend.sessioncycles.application.port.in;

public interface RemoveCapturedCallUseCase {

    /** @return true if a captured call with this id existed in this cycle and was removed. */
    boolean removeCall(String cycleId, String callId);
}
