package com.alfred.pennyworth.sessioncycles.application.port.in;

import com.alfred.pennyworth.sessioncycles.domain.model.SessionCycle;
import com.alfred.pennyworth.sessioncycles.domain.model.SessionCycleUpdate;

import java.util.Optional;

public interface UpdateSessionCycleUseCase {

    Optional<SessionCycle> update(String id, SessionCycleUpdate update);
}
