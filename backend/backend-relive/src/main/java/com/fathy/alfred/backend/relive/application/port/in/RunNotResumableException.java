package com.fathy.alfred.backend.relive.application.port.in;

/** Resume refused because the run isn't in FAILED/STOPPED/INTERRUPTED (FR-034d, 409). */
public class RunNotResumableException extends RuntimeException {

    public RunNotResumableException(String runId) {
        super("Run " + runId + " cannot be resumed from its current status");
    }
}
