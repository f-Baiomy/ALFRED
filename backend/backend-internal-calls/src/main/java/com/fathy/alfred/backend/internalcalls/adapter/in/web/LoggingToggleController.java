package com.fathy.alfred.backend.internalcalls.adapter.in.web;

import com.fathy.alfred.backend.internalcalls.adapter.in.web.dto.FeatureEnabledDto;
import com.fathy.alfred.backend.internalcalls.adapter.in.web.dto.SetServiceEnabledRequestDto;
import com.fathy.alfred.backend.internalcalls.application.port.in.LoggingToggleUseCase;
import com.fathy.alfred.backend.internalcalls.domain.model.InternalCallService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * Lets the frontend flip the same per-project switches toggle-wildfly-reverse-proxy.sh/.bat
 * already control from a terminal - see LoggingTogglePort's doc. Forwarding to a project's
 * upstream is never affected either way, only whether reverse-proxy's webhook calls for that
 * one name (and therefore this slice's storage) happen at all.
 */
@RestController
public class LoggingToggleController {

    private final LoggingToggleUseCase loggingToggleUseCase;

    public LoggingToggleController(LoggingToggleUseCase loggingToggleUseCase) {
        this.loggingToggleUseCase = loggingToggleUseCase;
    }

    @GetMapping("/internal-calls/feature-enabled")
    public FeatureEnabledDto getFeatureEnabled() {
        return new FeatureEnabledDto(loggingToggleUseCase.isFeatureEnabled());
    }

    @GetMapping("/internal-calls/services")
    public List<InternalCallService> getServices() {
        return loggingToggleUseCase.getServices();
    }

    @PostMapping("/internal-calls/services/{name}/logging-enabled")
    public List<InternalCallService> setEnabled(@PathVariable String name, @RequestBody SetServiceEnabledRequestDto request) {
        return loggingToggleUseCase.setEnabled(name, request.enabled());
    }
}
