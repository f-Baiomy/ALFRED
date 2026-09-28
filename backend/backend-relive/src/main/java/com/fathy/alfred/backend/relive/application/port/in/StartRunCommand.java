package com.fathy.alfred.backend.relive.application.port.in;

import java.util.Map;

/** Body of {@code POST /relive-cycles/{id}/runs} (contracts/rest-api.md "Runs"). */
public record StartRunCommand(
        String driver,
        String fromStepKey,
        String seedFromRunId,
        Map<String, String> unattributedChoices
) {
}
