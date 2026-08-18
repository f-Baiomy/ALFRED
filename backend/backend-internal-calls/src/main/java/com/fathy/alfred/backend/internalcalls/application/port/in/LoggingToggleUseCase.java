package com.fathy.alfred.backend.internalcalls.application.port.in;

/** Inbound port: read/flip whether wildfly-proxy is currently logging calls to this slice. */
public interface LoggingToggleUseCase {

    boolean isEnabled();

    void setEnabled(boolean enabled);

    /**
     * Whether the inbound-logging feature exists at all for this deployment - a deploy-time flag
     * (settings.md's inbound_logging_enabled, baked into the INBOUND_LOGGING_ENABLED env var by
     * start.py/restart.py), distinct from {@link #isEnabled()}'s live on/off switch. When false,
     * wildfly-proxy itself was never started either (see docker-compose.yml's profiles: key) -
     * the frontend uses this to hide the Settings panel entirely rather than show a live toggle
     * for a feature that isn't running.
     */
    boolean isFeatureEnabled();
}
