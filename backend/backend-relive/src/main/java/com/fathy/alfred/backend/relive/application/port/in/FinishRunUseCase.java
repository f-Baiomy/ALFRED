package com.fathy.alfred.backend.relive.application.port.in;

import com.fathy.alfred.backend.relive.domain.model.Run;
import com.fathy.alfred.backend.relive.domain.model.RunStatus;

/** Inbound port: the engine (or the frontend, on its behalf) settles the run on its last step. */
public interface FinishRunUseCase {

    Run finish(String runId, RunStatus status);
}
