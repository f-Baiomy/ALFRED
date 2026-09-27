package com.fathy.alfred.backend.relive.domain.model;

/**
 * One variable value, optionally with when/where it was set. {@code stepKey}/{@code at} are
 * null in a StepResult's {@code variablesUsed}/{@code variablesProduced} (the step is already
 * the context); they are set in a Run's {@code variableTimeline}.
 */
public record VariableChange(String name, String value, String stepKey, String at) {

    /** For StepResult.variablesUsed / variablesProduced, which carry no timestamp of their own. */
    public static VariableChange of(String name, String value) {
        return new VariableChange(name, value, null, null);
    }
}
