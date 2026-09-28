package com.fathy.alfred.backend.relive.application.service;

import com.fathy.alfred.backend.relive.application.port.in.ValidateCycleUseCase;
import com.fathy.alfred.backend.relive.application.port.out.GlobalRulesLookupPort;
import com.fathy.alfred.backend.relive.application.port.out.ReliveCycleStorePort;
import com.fathy.alfred.backend.relive.domain.model.ValidationFinding;
import org.springframework.stereotype.Service;

import java.util.List;

/** Pre-run validation (FR-017) - delegates the actual rules to {@link CycleValidator}. */
@Service
public class CycleValidationService implements ValidateCycleUseCase {

    private final ReliveCycleStorePort cycleStore;
    private final CycleValidator validator;

    public CycleValidationService(ReliveCycleStorePort cycleStore, GlobalRulesLookupPort globalRulesLookup) {
        this.cycleStore = cycleStore;
        this.validator = new CycleValidator(globalRulesLookup);
    }

    @Override
    public List<ValidationFinding> validate(String cycleId) {
        return cycleStore.findById(cycleId).map(validator::validate).orElse(List.of());
    }
}
