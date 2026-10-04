package com.fathy.alfred.backend.dbcapture.adapter.in.web.dto;

import com.fathy.alfred.backend.dbcapture.domain.model.AgentStatus;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/** POST /db-capture/agent/heartbeat's body. */
public record HeartbeatRequestDto(
        @NotBlank @Size(max = 200) String agentId,
        @NotBlank @Size(max = 200) String project,
        @Size(max = 50) String agentVersion,
        @Size(max = 300) String jvm,
        @Size(max = 300) String appServer,
        @Min(0) long droppedSinceStart,
        @Min(0) long queuedStatements
) {
    public AgentStatus toDomain() {
        return new AgentStatus(agentId, project, agentVersion, jvm, appServer, droppedSinceStart, queuedStatements, null);
    }
}
