package com.fathy.alfred.backend.relive.application.service;

import com.fathy.alfred.backend.relive.application.port.in.ValidateCycleUseCase;
import com.fathy.alfred.backend.relive.domain.model.ValidationFinding;
import org.springframework.stereotype.Service;

import java.util.List;

/**
 * Pre-run validation (FR-017). A stub until T045 fills it in with the full finding set
 * (UNRESOLVED_VARIABLE, MISSING_RECORDING, DUPLICATE_STEP, GLOBAL_RULE_GONE, RULE_OVERLAP,
 * NOTHING_TO_RUN, MAY_BE_UNATTRIBUTED, LIVE_EXTERNAL, UNUSED_VARIABLE, ORDER_DEPENDENCY).
 */
@Service
public class CycleValidationService implements ValidateCycleUseCase {

    @Override
    public List<ValidationFinding> validate(String cycleId) {
        return List.of();
    }
}
