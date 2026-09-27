package com.fathy.alfred.backend.relive.application.port.in;

/** The cycle changed elsewhere since the caller last read it (optimistic concurrency, 409). */
public class StaleCycleException extends RuntimeException {

    public StaleCycleException(String cycleId) {
        super("Cycle " + cycleId + " was changed elsewhere - reload before saving again");
    }
}
