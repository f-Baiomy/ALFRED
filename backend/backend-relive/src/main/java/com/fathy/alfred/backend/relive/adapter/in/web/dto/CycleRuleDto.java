package com.fathy.alfred.backend.relive.adapter.in.web.dto;

import com.fasterxml.jackson.databind.JsonNode;
import com.fathy.alfred.backend.relive.domain.model.CopiedFrom;
import com.fathy.alfred.backend.relive.domain.model.CycleRule;
import jakarta.validation.constraints.NotNull;

public record CycleRuleDto(@NotNull JsonNode rule, CopiedFrom copiedFrom) {

    public CycleRule toDomain() {
        return new CycleRule(rule, copiedFrom);
    }

    public static CycleRuleDto from(CycleRule rule) {
        return rule == null ? null : new CycleRuleDto(rule.rule(), rule.copiedFrom());
    }
}
