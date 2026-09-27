package com.fathy.alfred.backend.scenarios.application.port.in;

public interface DeleteScenarioUseCase {

    /** Also deletes every run of this scenario (cascade). @return true if a scenario with this id existed and was deleted. */
    boolean deleteById(String id);
}
