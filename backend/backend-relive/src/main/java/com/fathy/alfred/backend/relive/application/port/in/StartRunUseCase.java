package com.fathy.alfred.backend.relive.application.port.in;

import com.fathy.alfred.backend.relive.domain.model.Run;

/** Inbound port: starts a run of a cycle (FR-030 and friends). */
public interface StartRunUseCase {

    /** @throws RunBlockedException when pre-run validation finds a BLOCK finding (422). */
    Run start(String cycleId, StartRunCommand command);
}
