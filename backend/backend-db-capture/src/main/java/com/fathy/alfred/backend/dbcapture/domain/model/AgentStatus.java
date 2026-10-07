package com.fathy.alfred.backend.dbcapture.domain.model;

/**
 * What an agent reports in its heartbeat. {@code lastSeen} is set by the backend when it arrives; an agent counts as
 * attached while it was seen within {@link #ATTACHED_WITHIN_SECONDS} (three missed heartbeats).
 */
public record AgentStatus(String agentId, String project, String agentVersion, String jvm, String appServer,
                          long droppedSinceStart, long queuedStatements, String lastSeen, java.util.Map<String, Object> redis) {

    public AgentStatus(String agentId, String project, String agentVersion, String jvm, String appServer,
                       long droppedSinceStart, long queuedStatements, String lastSeen) {
        this(agentId, project, agentVersion, jvm, appServer, droppedSinceStart, queuedStatements, lastSeen, null);
    }

    public static final int ATTACHED_WITHIN_SECONDS = 30;

    public AgentStatus seenAt(String instant) {
        return new AgentStatus(agentId, project, agentVersion, jvm, appServer, droppedSinceStart, queuedStatements, instant, redis);
    }
}
