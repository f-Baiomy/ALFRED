package com.fathy.alfred.backend.relive.application.port.in;

/** Inbound port: appends to a run's variable timeline, republishing only if the variable is
 *  referenced by a cycle/global rule of this run's definition. */
public interface SetRunVariableUseCase {

    void setVariable(String runId, String name, String value, String stepKey);

    /** Several values a step produced at once: one write and at most one republish (review P11). */
    void setVariables(String runId, java.util.List<NewValue> values);

    record NewValue(String name, String value, String stepKey) {
    }
}
