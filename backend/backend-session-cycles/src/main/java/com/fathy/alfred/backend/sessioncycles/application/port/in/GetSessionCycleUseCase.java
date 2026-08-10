package com.fathy.alfred.backend.sessioncycles.application.port.in;

import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;

import java.util.Optional;

public interface GetSessionCycleUseCase {

    Optional<SessionCycle> getById(String id);
}
