package com.fathy.alfred.backend.sessioncycles.application.port.in;

import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;

import java.util.List;

public interface ListSessionCyclesUseCase {

    List<SessionCycle> listAll();
}
