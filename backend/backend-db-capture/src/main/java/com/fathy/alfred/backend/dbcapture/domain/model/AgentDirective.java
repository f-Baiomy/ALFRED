package com.fathy.alfred.backend.dbcapture.domain.model;

/**
 * What a heartbeat answers: the project's settings and whether its capture switch is on. The switch already reaches
 * captured CALLS through the proxy's X-Alfred-Call header; the agent needs it here only for statements outside any call.
 */
public record AgentDirective(DbCaptureSettings settings, boolean captureEnabled) {
}
