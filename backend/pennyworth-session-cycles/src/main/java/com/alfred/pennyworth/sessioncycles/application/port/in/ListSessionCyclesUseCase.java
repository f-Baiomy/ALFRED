package com.alfred.pennyworth.sessioncycles.application.port.in;

import com.alfred.pennyworth.sessioncycles.domain.model.SessionCycle;

import java.util.List;

public interface ListSessionCyclesUseCase {

    List<SessionCycle> listAll();
}
