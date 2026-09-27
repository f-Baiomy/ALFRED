package com.fathy.alfred.backend.relive.application.port.in;

import com.fathy.alfred.backend.relive.domain.model.ValidationFinding;

import java.util.List;

/** Inbound port: pre-run validation (FR-017), richer than the save-time checks. */
public interface ValidateCycleUseCase {

    List<ValidationFinding> validate(String cycleId);
}
