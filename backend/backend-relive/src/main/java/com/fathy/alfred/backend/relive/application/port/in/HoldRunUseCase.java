package com.fathy.alfred.backend.relive.application.port.in;

import com.fathy.alfred.backend.relive.domain.model.Run;

/** Inbound port: sets or clears a run's hold (FR-034). {@code reason == null} clears it (logged CONTINUED). */
public interface HoldRunUseCase {

    Run hold(String runId, String stepKey, String reason);
}
