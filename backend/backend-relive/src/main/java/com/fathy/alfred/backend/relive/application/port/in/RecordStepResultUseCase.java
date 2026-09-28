package com.fathy.alfred.backend.relive.application.port.in;

import com.fathy.alfred.backend.relive.domain.model.StepResult;

/** Inbound port: PUT one step attempt's result, recomputing the run's summary (FR-035). */
public interface RecordStepResultUseCase {

    void recordStepResult(String runId, StepResult result);
}
