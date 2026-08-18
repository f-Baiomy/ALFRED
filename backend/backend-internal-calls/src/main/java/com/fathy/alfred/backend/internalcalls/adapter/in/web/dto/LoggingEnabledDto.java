package com.fathy.alfred.backend.internalcalls.adapter.in.web.dto;

/**
 * {@code enabled} is the live on/off switch (see LoggingTogglePort); {@code featureEnabled} is
 * the deploy-time flag (see LoggingToggleUseCase.isFeatureEnabled) - the frontend hides the whole
 * Settings panel when the latter is false, regardless of the former.
 */
public record LoggingEnabledDto(boolean enabled, boolean featureEnabled) {
}
