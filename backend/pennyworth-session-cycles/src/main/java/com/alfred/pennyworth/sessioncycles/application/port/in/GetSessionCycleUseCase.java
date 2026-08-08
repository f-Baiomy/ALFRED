package com.alfred.pennyworth.sessioncycles.application.port.in;

import com.alfred.pennyworth.sessioncycles.domain.model.SessionCycle;

import java.util.Optional;

public interface GetSessionCycleUseCase {

    Optional<SessionCycle> getById(String id);
}
