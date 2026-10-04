package com.fathy.alfred.backend.dbcapture.application.port.in;

import com.fathy.alfred.backend.dbcapture.domain.model.AgentStatus;
import com.fathy.alfred.backend.dbcapture.domain.model.AgentDirective;

/** Records that an agent is alive and hands it its project's current capture settings. */
public interface RecordAgentHeartbeatUseCase {
    AgentDirective heartbeat(AgentStatus status);
}
