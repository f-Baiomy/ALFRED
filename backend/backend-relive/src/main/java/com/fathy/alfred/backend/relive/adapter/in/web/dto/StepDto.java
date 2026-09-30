package com.fathy.alfred.backend.relive.adapter.in.web.dto;

import com.fasterxml.jackson.databind.JsonNode;
import com.fathy.alfred.backend.relive.domain.model.FrozenCall;
import com.fathy.alfred.backend.relive.domain.model.NoiseRule;
import com.fathy.alfred.backend.relive.domain.model.Step;
import com.fathy.alfred.backend.relive.domain.model.StepSource;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

import java.util.List;

public record StepDto(
        @NotBlank String key,
        String parentKey,
        @NotBlank String label,
        boolean enabled,
        boolean optional,
        @NotBlank String direction,
        String serviceName,
        @Valid @NotNull CycleRuleDto callRule,
        @NotBlank String unattributed,
        FrozenCall recording,
        StepSource source,
        JsonNode extract,
        JsonNode assertions,
        List<NoiseRule> noise,
        String fingerprint,
        String fingerprintVersion
) {
    public Step toDomain() {
        return new Step(key, parentKey, label, enabled, optional, direction, serviceName,
                callRule.toDomain(), unattributed, recording, source, extract, assertions,
                noise == null ? List.of() : noise, fingerprint, fingerprintVersion);
    }

    public static StepDto from(Step step) {
        return new StepDto(step.key(), step.parentKey(), step.label(), step.enabled(), step.optional(),
                step.direction(), step.serviceName(), CycleRuleDto.from(step.callRule()), step.unattributed(),
                step.recording(), step.source(), step.extract(), step.assertions(), step.noise(),
                step.fingerprint(), step.fingerprintVersion());
    }
}
