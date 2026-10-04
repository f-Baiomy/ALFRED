package com.fathy.alfred.backend.dbcapture.adapter.in.web.dto;

import com.fathy.alfred.backend.dbcapture.domain.model.AgentDirective;

import java.util.List;

/** What the heartbeat hands the agent - the settings it acts on; thresholds and expected statements stay backend-side. */
public record AgentSettingsResponse(int rowsPerResult, List<String> beforeImageTables, boolean outsideCallCapture, boolean captureEnabled,
                                    List<String> ignorePatterns) {

    public static AgentSettingsResponse of(AgentDirective directive) {
        var settings = directive.settings();
        return new AgentSettingsResponse(settings.rowsPerResult(), settings.beforeImageTables(), settings.outsideCallCapture(),
                directive.captureEnabled(), settings.ignorePatterns());
    }
}
