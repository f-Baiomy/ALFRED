package com.fathy.alfred.backend.dbcapture.application.port.out;

import com.fathy.alfred.backend.dbcapture.domain.model.InboundProject;

import java.util.List;

/** The projects the reverse proxy fronts with their inbound-logging state. Implemented in backend-app (this slice may not read backend-internal-calls). */
public interface InboundProjectsPort {
    List<InboundProject> projects();
}
