package com.fathy.alfred.backend.internalcalls.adapter.in.web;

import com.fathy.alfred.backend.internalcalls.adapter.in.web.dto.LoggingEnabledDto;
import com.fathy.alfred.backend.internalcalls.application.port.in.LoggingToggleUseCase;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * Lets the frontend flip the same switch toggle-wildfly-reverse-proxy.sh/.bat already control from
 * a terminal - see LoggingTogglePort's doc. Forwarding to WildFly is never affected either way,
 * only whether wildfly-proxy's webhook calls (and therefore this slice's storage) happen at all.
 */
@RestController
public class LoggingToggleController {

    private final LoggingToggleUseCase loggingToggleUseCase;

    public LoggingToggleController(LoggingToggleUseCase loggingToggleUseCase) {
        this.loggingToggleUseCase = loggingToggleUseCase;
    }

    @GetMapping("/internal-calls/logging-enabled")
    public LoggingEnabledDto getEnabled() {
        return new LoggingEnabledDto(loggingToggleUseCase.isEnabled(), loggingToggleUseCase.isFeatureEnabled());
    }

    /** {@code request.featureEnabled()} is ignored - that flag is deploy-time only, never settable at runtime. */
    @PostMapping("/internal-calls/logging-enabled")
    public LoggingEnabledDto setEnabled(@RequestBody LoggingEnabledDto request) {
        loggingToggleUseCase.setEnabled(request.enabled());
        return new LoggingEnabledDto(loggingToggleUseCase.isEnabled(), loggingToggleUseCase.isFeatureEnabled());
    }
}
