package com.fathy.alfred.backend.relive.application.port.in;

import com.fathy.alfred.backend.relive.domain.model.ReliveCycle;
import com.fathy.alfred.backend.relive.domain.model.Run;

/** Inbound port: mid-run edit (FR-044a) - merges only the steps in {@code definition} that have
 *  no StepResult yet. */
public interface UpdateRunDefinitionUseCase {

    /** @throws RunDefinitionConflictException when a changed step already has a result */
    Run updateDefinition(String runId, ReliveCycle definition, String reason);
}
