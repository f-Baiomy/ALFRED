package com.fathy.alfred.backend.relive.application.port.in;

import com.fathy.alfred.backend.relive.domain.model.Run;

import java.util.List;

/** Inbound port: headers+summary only, newest first (constitution II). */
public interface ListRunsUseCase {

    List<Run> list(String cycleId, int limit);
}
