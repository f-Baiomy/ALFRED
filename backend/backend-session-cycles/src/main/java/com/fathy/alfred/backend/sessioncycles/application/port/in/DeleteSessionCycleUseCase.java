package com.fathy.alfred.backend.sessioncycles.application.port.in;

import com.fathy.alfred.backend.sessioncycles.domain.model.DeleteOutcome;

public interface DeleteSessionCycleUseCase {

    DeleteOutcome delete(String id);
}
