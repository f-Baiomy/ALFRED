package com.fathy.alfred.backend.relive.adapter.in.web.dto;

import com.fathy.alfred.backend.relive.application.port.in.StartRunCommand;

import java.util.Map;

/** Body of {@code POST /relive-cycles/{id}/runs}. */
public record StartRunRequestDto(
        String driver,
        String fromStepKey,
        String seedFromRunId,
        Map<String, String> unattributedChoices
) {
    public StartRunCommand toCommand() {
        return new StartRunCommand(driver, fromStepKey, seedFromRunId,
                unattributedChoices == null ? Map.of() : unattributedChoices);
    }

    public static StartRunRequestDto empty() {
        return new StartRunRequestDto(null, null, null, Map.of());
    }
}
