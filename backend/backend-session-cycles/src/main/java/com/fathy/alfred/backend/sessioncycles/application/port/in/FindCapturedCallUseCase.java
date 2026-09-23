package com.fathy.alfred.backend.sessioncycles.application.port.in;

import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedCall;

import java.util.Optional;

/** A single captured (outbound) call, full wrapper (not just its detail projection) - backs resend from a session cycle. */
public interface FindCapturedCallUseCase {
    Optional<CapturedCall> findCaptured(String cycleId, String callId);
}
