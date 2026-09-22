package com.fathy.alfred.backend.sessioncycles.application.port.in;

public interface DeleteCycleSpacerUseCase {

    /** @return true if a spacer with this id existed in this cycle and was removed. */
    boolean deleteSpacer(String cycleId, String spacerId);
}
