package com.fathy.alfred.backend.relive.application.service;

import com.fathy.alfred.backend.relive.application.port.in.ValidateCycleUseCase;
import com.fathy.alfred.backend.relive.application.port.out.GlobalRulesLookupPort;
import com.fathy.alfred.backend.relive.application.port.out.ReliveCycleStorePort;
import com.fathy.alfred.backend.relive.application.port.out.ReliveRunStorePort;
import com.fathy.alfred.backend.relive.domain.model.ValidationFinding;
import org.springframework.stereotype.Service;

import java.util.List;

/** Pre-run validation (FR-017) - delegates the actual rules to {@link CycleValidator}. */
@Service
public class CycleValidationService implements ValidateCycleUseCase {

    private final ReliveCycleStorePort cycleStore;
    private final CycleValidator validator;

    public CycleValidationService(ReliveCycleStorePort cycleStore, GlobalRulesLookupPort globalRulesLookup, ReliveRunStorePort runStore) {
        this.cycleStore = cycleStore;
        this.validator = new CycleValidator(globalRulesLookup, runStore);
    }

    @Override
    public List<ValidationFinding> validate(String cycleId) {
        return cycleStore.findById(cycleId).map(validator::validate).orElse(List.of());
    }

    @Override
    public List<ValidationFinding> validate(String cycleId, String driver) {
        return cycleStore.findById(cycleId).map(cycle -> validator.validate(cycle, driver)).orElse(List.of());
    }
}
