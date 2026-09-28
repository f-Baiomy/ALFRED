package com.fathy.alfred.backend.relive.application.port.in;

/** updateDefinition refused because a step in the request already has a StepResult (FR-044a, 409). */
public class RunDefinitionConflictException extends RuntimeException {

    public RunDefinitionConflictException(String runId, String stepKey) {
        super("Run " + runId + " already has a result for step " + stepKey + " - it can't be redefined");
    }
}
