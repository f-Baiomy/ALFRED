package com.fathy.alfred.backend.dbcapturebridge;

import com.fathy.alfred.backend.dbcapture.application.port.out.InboundProjectsPort;
import com.fathy.alfred.backend.dbcapture.domain.model.InboundProject;
import com.fathy.alfred.backend.internalcalls.application.port.in.LoggingToggleUseCase;
import org.springframework.stereotype.Component;

import java.util.List;

/** Database capture's view of the reverse-proxied projects and their inbound-logging switch (backend-internal-calls). */
@Component
public class InboundProjectsAdapter implements InboundProjectsPort {

    private final LoggingToggleUseCase loggingToggle;

    public InboundProjectsAdapter(LoggingToggleUseCase loggingToggle) {
        this.loggingToggle = loggingToggle;
    }

    @Override
    public List<InboundProject> projects() {
        if (!loggingToggle.isFeatureEnabled()) {
            return List.of();
        }
        return loggingToggle.getServices().stream().map(s -> new InboundProject(s.name(), s.enabled())).toList();
    }
}
