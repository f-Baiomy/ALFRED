package com.fathy.alfred.backend.dbcapture.adapter.in.web.dto;

import com.fathy.alfred.backend.dbcapture.domain.model.CaughtLogLine;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Size;

/** One caught log line in an agent batch (specs/009-agent-log-capture, contracts/agent-log-capture.md); sizes clamped. */
public record LogLineDto(
        @Size(max = 200) String callId,
        @Min(0) int seq,
        @Size(max = 64) String at,
        @Size(max = 40) String level,
        @Size(max = 512) String logger,
        @Size(max = 512) String thread,
        @Size(max = 33_000) String message,
        @Size(max = 512) String exceptionType,
        @Size(max = 33_000) String exceptionMessage,
        @Size(max = 33_000) String exceptionStack,
        Boolean cut
) {
    public CaughtLogLine toDomain(String project) {
        return new CaughtLogLine(0, callId, seq, at, level, logger, thread, message, exceptionType, exceptionMessage, exceptionStack,
                Boolean.TRUE.equals(cut), project);
    }
}
