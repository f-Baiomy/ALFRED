package com.fathy.alfred.backend.relive.application.port.in;

/** Resume refused because another tab currently holds the run's lease (research D1, 409). */
public class RunLeaseHeldException extends RuntimeException {

    public RunLeaseHeldException(String runId) {
        super("Run " + runId + " is currently held by another tab");
    }
}
