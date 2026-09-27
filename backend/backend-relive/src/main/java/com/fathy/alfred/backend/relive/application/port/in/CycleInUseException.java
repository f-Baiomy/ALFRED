package com.fathy.alfred.backend.relive.application.port.in;

/** Delete refused because a RUNNING run of this cycle exists (409). */
public class CycleInUseException extends RuntimeException {

    public CycleInUseException(String cycleId) {
        super("Cycle " + cycleId + " has a run in progress - stop it before deleting the cycle");
    }
}
