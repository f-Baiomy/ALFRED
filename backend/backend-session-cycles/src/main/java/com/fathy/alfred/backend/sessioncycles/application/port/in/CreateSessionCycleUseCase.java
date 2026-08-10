package com.fathy.alfred.backend.sessioncycles.application.port.in;

import com.fathy.alfred.backend.sessioncycles.domain.model.NewSessionCycle;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;

public interface CreateSessionCycleUseCase {

    SessionCycle create(NewSessionCycle newSessionCycle);
}
