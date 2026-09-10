package com.fathy.alfred.backend.internalcalls.adapter.in.web.dto;

/** The deploy-time flag (settings.properties's reverse_proxy_enabled) - see LoggingToggleUseCase.isFeatureEnabled's doc. */
public record FeatureEnabledDto(boolean enabled) {
}
