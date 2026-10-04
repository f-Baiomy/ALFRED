package com.fathy.alfred.backend.dbcapture.domain.model;

/**
 * One project's capture switch as the Sources bar, the cycle widget and Settings show it - one setting, three places.
 * {@code inboundLogging} false means the switch is unavailable: statements attach to inbound calls, so with inbound
 * logging off there is nothing to attach them to. {@code agent} is the most recently seen agent of the project.
 */
public record ProjectCaptureStatus(String project, boolean enabled, boolean inboundLogging, boolean attached, AgentStatus agent) {
}
