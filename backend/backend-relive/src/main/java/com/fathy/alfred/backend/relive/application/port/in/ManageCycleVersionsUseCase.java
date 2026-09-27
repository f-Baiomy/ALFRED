package com.fathy.alfred.backend.relive.application.port.in;

import com.fathy.alfred.backend.relive.domain.model.CycleVersion;
import com.fathy.alfred.backend.relive.domain.model.ReliveCycle;

import java.util.List;

/** Inbound port: undo via saved versions (FR-007c). */
public interface ManageCycleVersionsUseCase {

    List<CycleVersion> list(String cycleId);

    ReliveCycle restore(String cycleId, int version);
}
