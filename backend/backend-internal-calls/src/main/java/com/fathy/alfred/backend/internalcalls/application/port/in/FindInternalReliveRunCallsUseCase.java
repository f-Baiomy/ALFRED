package com.fathy.alfred.backend.internalcalls.application.port.in;

import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;

import java.util.List;

/** Inbound port: every logged inbound call of one Relive run, full records - mirrors
 *  backend-calls' FindReliveRunCallsUseCase for a run's own session cycle. */
public interface FindInternalReliveRunCallsUseCase {

    List<CallRecord> findByRunId(String runId);
}
