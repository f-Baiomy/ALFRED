package com.fathy.alfred.backend.relive.application.port.in;

import com.fathy.alfred.backend.relive.domain.model.ValidationFinding;

import java.util.List;

/** Inbound port: pre-run validation (FR-017), richer than the save-time checks. */
public interface ValidateCycleUseCase {

    List<ValidationFinding> validate(String cycleId);

    /** For the driver this run will really use (the pre-run dialog can pick one other than the
     *  cycle's default), so the Guided-only checks apply when they should. */
    default List<ValidationFinding> validate(String cycleId, String driver) {
        return validate(cycleId);
    }
}
