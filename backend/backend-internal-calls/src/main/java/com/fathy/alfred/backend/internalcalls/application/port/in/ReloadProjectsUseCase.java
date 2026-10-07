package com.fathy.alfred.backend.internalcalls.application.port.in;

/**
 * Replaces the configured projects and the inbound-logging flag after the Server section saved them
 * (INTERNAL_CALL_SERVICES, REVERSE_PROXY_ENABLED): the supervisor restarts the proxies, this keeps the Settings tab's
 * "Inbound logging" panel in step without a backend restart.
 */
public interface ReloadProjectsUseCase {

    void reload(String servicesConfig, boolean featureEnabled);
}
