package com.fathy.alfred.backend.dbcapture.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * A log line the agent caught inside the application (specs/009-agent-log-capture): attached to its call, at its
 * place in the call's sequence ({@code seq}, shared with statements and supplier calls), or an outside-call line
 * ({@code callId == null}). {@code id} is assigned on storage (0 before).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record CaughtLogLine(long id, String callId, int seq, String at, String level, String logger, String thread, String message,
                            String exceptionType, String exceptionMessage, String exceptionStack, boolean cut, String project) {

    /** ERROR / FATAL / SEVERE. */
    public boolean error() {
        String l = level == null ? "" : level.toUpperCase(java.util.Locale.ROOT);
        return l.equals("ERROR") || l.equals("FATAL") || l.equals("SEVERE");
    }

    /** WARN / WARNING. */
    public boolean warning() {
        String l = level == null ? "" : level.toUpperCase(java.util.Locale.ROOT);
        return l.equals("WARN") || l.equals("WARNING");
    }
}
