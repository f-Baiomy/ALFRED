package com.fathy.alfred.backend.relive.application.port.in;

import com.fathy.alfred.backend.relive.domain.model.Run;

/** Inbound port: "Continue with the rest" of an ended run (FR-034d) - same run id. */
public interface ResumeRunUseCase {

    /**
     * @throws RunNotResumableException when the run isn't FAILED/STOPPED/INTERRUPTED
     * @throws RunLeaseHeldException when another tab currently holds the run's lease
     */
    Run resume(String runId, String afterStepKey);
}
