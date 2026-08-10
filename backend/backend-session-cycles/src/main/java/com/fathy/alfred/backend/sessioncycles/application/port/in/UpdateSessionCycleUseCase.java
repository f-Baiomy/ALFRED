package com.fathy.alfred.backend.sessioncycles.application.port.in;

import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycleUpdate;

import java.util.Optional;

public interface UpdateSessionCycleUseCase {

    Optional<SessionCycle> update(String id, SessionCycleUpdate update);
}
