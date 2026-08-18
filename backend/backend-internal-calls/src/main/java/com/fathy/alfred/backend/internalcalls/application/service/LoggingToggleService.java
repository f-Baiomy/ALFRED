package com.fathy.alfred.backend.internalcalls.application.service;

import com.fathy.alfred.backend.internalcalls.application.port.in.LoggingToggleUseCase;
import com.fathy.alfred.backend.internalcalls.application.port.out.LoggingTogglePort;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

@Service
public class LoggingToggleService implements LoggingToggleUseCase {

    private final LoggingTogglePort loggingTogglePort;

    /** Deploy-time flag - see LoggingToggleUseCase.isFeatureEnabled's doc. */
    @Value("${alfred.internal-calls.feature-enabled:false}")
    private boolean featureEnabled;

    public LoggingToggleService(LoggingTogglePort loggingTogglePort) {
        this.loggingTogglePort = loggingTogglePort;
    }

    @Override
    public boolean isEnabled() {
        return loggingTogglePort.isEnabled();
    }

    @Override
    public void setEnabled(boolean enabled) {
        loggingTogglePort.setEnabled(enabled);
    }

    @Override
    public boolean isFeatureEnabled() {
        return featureEnabled;
    }
}
