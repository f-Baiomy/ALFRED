package com.alfred.pennyworth.sessioncycles.application.port.in;

import com.alfred.pennyworth.sessioncycles.domain.model.DeleteOutcome;

public interface DeleteSessionCycleUseCase {

    DeleteOutcome delete(String id);
}
