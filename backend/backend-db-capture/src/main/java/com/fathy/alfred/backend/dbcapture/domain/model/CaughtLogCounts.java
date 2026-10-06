package com.fathy.alfred.backend.dbcapture.domain.model;

/** A call's caught lines at a glance - the card chip, without reading a line (specs/009-agent-log-capture). */
public record CaughtLogCounts(int lines, int errors, int warnings, int dropped, int exceptions) {

    public CaughtLogCounts(int lines, int errors, int warnings, int dropped) {
        this(lines, errors, warnings, dropped, 0);
    }
}
