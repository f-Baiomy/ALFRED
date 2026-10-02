package com.fathy.alfred.backend.relivebridge;

import com.fathy.alfred.backend.interception.application.port.in.ManageInterceptionRulesUseCase;
import com.fathy.alfred.backend.relive.application.port.out.GlobalRuleRef;
import com.fathy.alfred.backend.relive.application.port.out.GlobalRulesLookupPort;
import org.springframework.stereotype.Component;

import java.util.List;

/** Bridges Relive's "which global rules exist" lookup (research D4's SELECTED mode, the rule
 *  editor's "copy a global rule" picker) to backend-interception's own rule list. */
@Component
public class GlobalRulesLookupAdapter implements GlobalRulesLookupPort {

    private final ManageInterceptionRulesUseCase manageRules;
    private final com.fasterxml.jackson.databind.ObjectMapper objectMapper;

    public GlobalRulesLookupAdapter(ManageInterceptionRulesUseCase manageRules,
                                    com.fasterxml.jackson.databind.ObjectMapper objectMapper) {
        this.manageRules = manageRules;
        this.objectMapper = objectMapper;
    }

    /** With each rule's match, so pre-run validation can report a GLOBAL/CYCLE overlap (FR-017). */
    @Override
    public List<GlobalRuleRef> list() {
        return manageRules.list().stream()
                .map(r -> new GlobalRuleRef(r.id(), r.name(), r.enabled(), objectMapper.valueToTree(r.match())))
                .toList();
    }

    @Override
    public boolean exists(String id) {
        return manageRules.list().stream().anyMatch(r -> r.id().equals(id));
    }
}
