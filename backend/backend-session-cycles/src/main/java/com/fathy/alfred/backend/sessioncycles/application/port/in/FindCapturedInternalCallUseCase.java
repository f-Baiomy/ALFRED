package com.fathy.alfred.backend.sessioncycles.application.port.in;

import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedInternalCall;

import java.util.Optional;

/** A single captured (inbound) call, full wrapper (not just its detail projection) - backs resend from a session cycle. */
public interface FindCapturedInternalCallUseCase {
    Optional<CapturedInternalCall> findCaptured(String cycleId, String callId);
}
