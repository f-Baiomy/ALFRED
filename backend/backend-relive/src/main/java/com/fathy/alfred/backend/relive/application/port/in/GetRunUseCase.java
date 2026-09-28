package com.fathy.alfred.backend.relive.application.port.in;

import com.fathy.alfred.backend.relive.domain.model.Run;
import com.fathy.alfred.backend.relive.domain.model.StepResult;

import java.util.List;
import java.util.Optional;

/** Inbound port: one run in full (definition, log, and every step attempt - bodies+secrets included). */
public interface GetRunUseCase {

    Optional<RunDetail> get(String runId);

    record RunDetail(Run run, List<StepResult> stepResults) {
    }
}
