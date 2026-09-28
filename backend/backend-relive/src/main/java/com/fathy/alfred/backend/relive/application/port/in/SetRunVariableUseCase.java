package com.fathy.alfred.backend.relive.application.port.in;

/** Inbound port: appends to a run's variable timeline, republishing only if the variable is
 *  referenced by a cycle/global rule of this run's definition. */
public interface SetRunVariableUseCase {

    void setVariable(String runId, String name, String value, String stepKey);
}
