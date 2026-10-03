package com.fathy.alfred.backend.calls.application.port.in;

import com.fathy.alfred.backend.calls.domain.model.CallRecord;

import java.util.List;

/** Inbound port: every logged call of one Relive run, full records (bodies included) - what a
 *  run's own session cycle is filled from when it is created after the run (backend-app's
 *  relivebridge; backend-session-cycles never depends on this slice's ports). */
public interface FindReliveRunCallsUseCase {

    List<CallRecord> findByRunId(String runId);
}
