package com.fathy.alfred.backend.internalcalls.application.port.in;

import com.fathy.alfred.backend.internalcalls.domain.model.InternalCallService;

import java.util.List;

/**
 * Inbound port: list every project reverse-proxy fronts (deploy-time, from
 * alfred.internal-calls.services) joined with each one's live logging on/off state, plus flip
 * one by name. There is no single "all projects" switch - every name (including the reserved
 * "unknown" bucket for unmatched Host headers) is toggled independently.
 */
public interface LoggingToggleUseCase {

    List<InternalCallService> getServices();

    List<InternalCallService> setEnabled(String name, boolean enabled);

    /**
     * Whether the inbound-logging feature exists at all for this deployment - a deploy-time
     * flag (settings.properties's reverse_proxy_enabled, baked into the REVERSE_PROXY_ENABLED
     * env var by start.py/restart.py). When false, reverse-proxy itself was never started
     * either (see docker-compose.yml's profiles: key) - the frontend uses this to hide the
     * Settings panel entirely rather than show a live toggle for a feature that isn't running.
     */
    boolean isFeatureEnabled();
}
