package com.fathy.alfred.backend.relive.adapter.in.web.dto;

import com.fathy.alfred.backend.relive.domain.model.CycleVariable;
import com.fathy.alfred.backend.relive.domain.model.GlobalRulesSelection;
import com.fathy.alfred.backend.relive.domain.model.NoiseRule;
import com.fathy.alfred.backend.relive.domain.model.ReliveCycle;
import com.fathy.alfred.backend.relive.domain.model.ReliveSettings;
import com.fathy.alfred.backend.relive.domain.model.UnexpectedCallsPolicy;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

import java.util.List;

/** What POST/PUT /relive-cycles accepts - server-assigned fields (id, timestamps) are omitted. */
public record ReliveCycleRequestDto(
        @NotBlank @Size(max = 120) String name,
        @Size(max = 2000) String description,
        @Valid @Size(max = 500) List<StepDto> steps,
        @Valid @Size(max = 200) List<CycleVariable> variables,
        @Valid @Size(max = 200) List<CycleRuleDto> cycleRules,
        GlobalRulesSelection globalRules,
        ReliveSettings settings,
        List<NoiseRule> noise,
        UnexpectedCallsRequestDto unexpectedCalls
) {
    public ReliveCycle toDomain(String id) {
        return new ReliveCycle(id, name, description,
                steps == null ? List.of() : steps.stream().map(StepDto::toDomain).toList(),
                variables == null ? List.of() : variables,
                cycleRules == null ? List.of() : cycleRules.stream().map(CycleRuleDto::toDomain).toList(),
                globalRules, settings, noise == null ? List.of() : noise,
                unexpectedCalls == null ? new UnexpectedCallsPolicy("BLOCK", List.of(), "BLOCK") : unexpectedCalls.toDomain(),
                null, null, false, null);
    }

    public record UnexpectedCallsRequestDto(String policy, List<CycleRuleDto> rules, String fallback) {
        public UnexpectedCallsPolicy toDomain() {
            return new UnexpectedCallsPolicy(policy,
                    rules == null ? List.of() : rules.stream().map(CycleRuleDto::toDomain).toList(), fallback);
        }
    }
}
