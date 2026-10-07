package com.fathy.alfred.backend.dbcapture.domain.model;

/**
 * One project's capture switch as the Sources bar, the cycle widget and Settings show it - one setting, three places.
 * {@code inboundLogging} false means the switch is unavailable: statements attach to inbound calls, so with inbound
 * logging off there is nothing to attach them to. {@code agent} is the most recently seen agent of the project.
 * {@code logsOn} is the project's ▤ Logs switch (specs/008-logs-call-link), unavailable the same way; {@code logLevel} the
 * lowest level of line the agent catches for it (specs/009, Settings → Database capture).
 */
public record ProjectCaptureStatus(String project, boolean enabled, boolean inboundLogging, boolean attached, AgentStatus agent,
                                   boolean logsOn, String logLevel, boolean redisOn, java.util.List<java.util.Map<String, Object>> redisClients,
                                   java.util.List<String> springCaches) {

    /** {@code redisOn}: the ⬢ Redis switch (specs/011-redis-capture); clients and Spring caches as the agent last reported them. */
    public ProjectCaptureStatus(String project, boolean enabled, boolean inboundLogging, boolean attached, AgentStatus agent,
                                boolean logsOn, String logLevel) {
        this(project, enabled, inboundLogging, attached, agent, logsOn, logLevel, false, java.util.List.of(), java.util.List.of());
    }

    public ProjectCaptureStatus(String project, boolean enabled, boolean inboundLogging, boolean attached, AgentStatus agent, boolean logsOn) {
        this(project, enabled, inboundLogging, attached, agent, logsOn, DbCaptureSettings.DEFAULT_LOG_LEVEL);
    }

    public ProjectCaptureStatus(String project, boolean enabled, boolean inboundLogging, boolean attached, AgentStatus agent) {
        this(project, enabled, inboundLogging, attached, agent, false);
    }
}
