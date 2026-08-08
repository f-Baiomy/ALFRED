package com.alfred.pennyworth.sessioncycles.application.port.in;

import com.alfred.pennyworth.sessioncycles.domain.model.NewSessionCycle;
import com.alfred.pennyworth.sessioncycles.domain.model.SessionCycle;

public interface CreateSessionCycleUseCase {

    SessionCycle create(NewSessionCycle newSessionCycle);
}
