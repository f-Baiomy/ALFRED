package com.fathy.alfred.backend.dbcapture.domain.model;

/**
 * What an agent reports in its heartbeat. {@code lastSeen} is set by the backend when it arrives; an agent counts as
 * attached while it was seen within {@link #ATTACHED_WITHIN_SECONDS} (three missed heartbeats). {@code features} is
 * the set the agent runs ("proxy,db,logs,redis" order, "" when none, null from an agent too old to say): a switch on
 * here for a feature the agent lacks is shown on the call - a {@code start.py} proxy-on step alone loads only the
 * proxy, and before the heartbeat said so that looked like capture silently gone.
 */
public record AgentStatus(String agentId, String project, String agentVersion, String jvm, String appServer,
                          long droppedSinceStart, long queuedStatements, String lastSeen, java.util.Map<String, Object> redis,
                          String features) {

    public AgentStatus(String agentId, String project, String agentVersion, String jvm, String appServer,
                       long droppedSinceStart, long queuedStatements, String lastSeen, java.util.Map<String, Object> redis) {
        this(agentId, project, agentVersion, jvm, appServer, droppedSinceStart, queuedStatements, lastSeen, redis, null);
    }

    public AgentStatus(String agentId, String project, String agentVersion, String jvm, String appServer,
                       long droppedSinceStart, long queuedStatements, String lastSeen) {
        this(agentId, project, agentVersion, jvm, appServer, droppedSinceStart, queuedStatements, lastSeen, null, null);
    }

    public static final int ATTACHED_WITHIN_SECONDS = 30;

    public AgentStatus seenAt(String instant) {
        return new AgentStatus(agentId, project, agentVersion, jvm, appServer, droppedSinceStart, queuedStatements, instant, redis, features);
    }

    /** True when the agent said what it runs and that set lacks {@code feature}. */
    public boolean lacks(String feature) {
        return features != null && java.util.Arrays.stream(features.split(",")).map(String::trim).noneMatch(feature::equals);
    }
}
