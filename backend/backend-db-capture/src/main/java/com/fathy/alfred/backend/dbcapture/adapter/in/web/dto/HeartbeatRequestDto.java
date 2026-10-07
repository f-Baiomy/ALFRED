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
        @Min(0) long queuedStatements,
        RedisSeenDto redis
) {
    /** What the agent's Redis hooks have seen (specs/011-redis-capture) - bounded: 16 clients, 256 cache names. */
    public record RedisSeenDto(@Size(max = 16) java.util.List<java.util.Map<String, Object>> clients, @Size(max = 256) java.util.List<String> springCaches) {
    }

    public AgentStatus toDomain() {
        java.util.Map<String, Object> seen = null;
        if (redis != null) {
            seen = new java.util.LinkedHashMap<>();
            seen.put("clients", redis.clients() == null ? java.util.List.of() : redis.clients());
            seen.put("springCaches", redis.springCaches() == null ? java.util.List.of() : redis.springCaches());
        }
        return new AgentStatus(agentId, project, agentVersion, jvm, appServer, droppedSinceStart, queuedStatements, null, seen);
    }
}
