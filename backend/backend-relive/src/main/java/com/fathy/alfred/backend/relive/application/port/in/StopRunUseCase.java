package com.fathy.alfred.backend.relive.application.port.in;

import com.fathy.alfred.backend.relive.domain.model.Run;

/** Inbound port: user-initiated stop (FR-033). */
public interface StopRunUseCase {

    Run stop(String runId);
}
