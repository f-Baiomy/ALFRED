package com.fathy.alfred.backend.internalcalls.application.service;

import com.fathy.alfred.backend.internalcalls.application.port.in.LoggingToggleUseCase;
import com.fathy.alfred.backend.internalcalls.application.port.out.LoggingTogglePort;
import com.fathy.alfred.backend.internalcalls.domain.model.InternalCallService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;

@Service
public class LoggingToggleService implements LoggingToggleUseCase {

    private static final Logger log = LoggerFactory.getLogger(LoggingToggleService.class);

    /** Reserved name for a flow that arrived on an unconfigured port - must stay in sync with
     * proxy/log_and_route_reverse.py's UNKNOWN_NAME constant. */
    public static final String UNKNOWN_NAME = "unknown";

    private final LoggingTogglePort loggingTogglePort;

    /** Deploy-time flag - see LoggingToggleUseCase.isFeatureEnabled's doc. */
    @Value("${alfred.internal-calls.feature-enabled:false}")
    private boolean featureEnabled;

    /** "name:listenPort:upstreamPort" triples, comma-separated - the SAME format/env var
     * (INTERNAL_CALL_SERVICES, baked from settings.properties's internal_call_services) that
     * proxy/reverse-proxy-entrypoint.sh and log_and_route_reverse.py parse independently. Parsed
     * once at construction since this list is deploy-time, not live. */
    private final List<ServiceConfig> configuredServices;

    public LoggingToggleService(LoggingTogglePort loggingTogglePort,
                                 @Value("${alfred.internal-calls.services:}") String servicesConfig) {
        this.loggingTogglePort = loggingTogglePort;
        this.configuredServices = parseServicesConfig(servicesConfig);
    }

    @Override
    public List<InternalCallService> getServices() {
        List<InternalCallService> services = new ArrayList<>();
        for (ServiceConfig config : configuredServices) {
            services.add(new InternalCallService(config.name(), config.listenPort(), config.upstreamPort(),
                    loggingTogglePort.isEnabled(config.name())));
        }
        services.add(new InternalCallService(UNKNOWN_NAME, null, null, loggingTogglePort.isEnabled(UNKNOWN_NAME)));
        return services;
    }

    @Override
    public List<InternalCallService> setEnabled(String name, boolean enabled) {
        loggingTogglePort.setEnabled(name, enabled);
        return getServices();
    }

    @Override
    public boolean isFeatureEnabled() {
        return featureEnabled;
    }

    private static List<ServiceConfig> parseServicesConfig(String servicesConfig) {
        List<ServiceConfig> configs = new ArrayList<>();
        if (servicesConfig == null || servicesConfig.isBlank()) {
            return configs;
        }
        for (String triple : servicesConfig.split(",")) {
            triple = triple.strip();
            if (triple.isEmpty()) {
                continue;
            }
            String[] parts = triple.split(":", 3);
            if (parts.length != 3) {
                continue;
            }
            String name = parts[0].strip();
            if (name.equalsIgnoreCase(UNKNOWN_NAME)) {
                // Reserved - a configured project can't reuse this name (see the constant's doc).
                continue;
            }
            try {
                configs.add(new ServiceConfig(name,
                        Integer.parseInt(parts[1].strip()),
                        Integer.parseInt(parts[2].strip())));
            } catch (NumberFormatException e) {
                // Malformed triple (a non-numeric port) - skip it rather than failing startup
                // over one bad entry; the proxy side skips it the same way.
                log.warn("Ignoring malformed internal-call service entry '{}': {}", triple, e.getMessage());
            }
        }
        return configs;
    }

    private record ServiceConfig(String name, int listenPort, int upstreamPort) {
    }
}
