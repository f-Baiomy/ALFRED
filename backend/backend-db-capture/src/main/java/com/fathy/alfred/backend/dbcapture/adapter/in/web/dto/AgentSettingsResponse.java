package com.fathy.alfred.backend.dbcapture.adapter.in.web.dto;

import com.fathy.alfred.backend.dbcapture.domain.model.AgentDirective;

import java.util.List;

/**
 * What the heartbeat hands the agent - the settings it acts on; thresholds and expected statements stay backend-side.
 * An older agent ignores the fields it does not know (passThroughClasses, callerFrames, indexInfo, logLevel).
 */
public record AgentSettingsResponse(int rowsPerResult, List<String> beforeImageTables, boolean outsideCallCapture, boolean captureEnabled,
                                    List<String> ignorePatterns, List<String> passThroughClasses, int callerFrames, boolean indexInfo,
                                    boolean logsOn, String logLevel) {

    public static AgentSettingsResponse of(AgentDirective directive) {
        var settings = directive.settings();
        return new AgentSettingsResponse(settings.rowsPerResult(), settings.beforeImageTables(), settings.outsideCallCapture(),
                directive.captureEnabled(), settings.ignorePatterns(), settings.passThroughClasses(), settings.callerFrames(), settings.indexInfo(),
                directive.logsOn(), settings.logLevel());
    }
}
