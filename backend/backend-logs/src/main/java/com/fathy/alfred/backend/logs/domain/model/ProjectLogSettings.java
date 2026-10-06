package com.fathy.alfred.backend.logs.domain.model;

import java.util.List;

/**
 * Which loaded log sources belong to a project the reverse proxy fronts, and how their lines are matched to the
 * project's calls (specs/008-logs-call-link): the field holding the request thread, the time field (null = the
 * source's TIME-role field), the field the db-agent's tag lands in, and how far the log's clock may be off ALFRED's.
 * Whether linking runs at all is the project's ▤ switch, not a setting here.
 */
public record ProjectLogSettings(
        String project,
        List<String> sourceIds,
        String threadField,
        String timeField,
        String callIdField,
        int clockSkewMs
) {
    public static final String DEFAULT_CALL_ID_FIELD = "mdc.alfred.call";
    public static final int DEFAULT_CLOCK_SKEW_MS = 200;
    public static final int MAX_CLOCK_SKEW_MS = 5_000;
    public static final int MAX_SOURCES = 20;
    static final int MAX_FIELD = 300;

    public ProjectLogSettings {
        sourceIds = sourceIds == null ? List.of() : List.copyOf(sourceIds);
        threadField = blankToNull(threadField);
        timeField = blankToNull(timeField);
        callIdField = blankToNull(callIdField) == null ? DEFAULT_CALL_ID_FIELD : callIdField.strip();
        if (sourceIds.size() > MAX_SOURCES) {
            throw new IllegalArgumentException("At most " + MAX_SOURCES + " log sources per project");
        }
        if (clockSkewMs < 0 || clockSkewMs > MAX_CLOCK_SKEW_MS) {
            throw new IllegalArgumentException("Clock difference must be between 0 and " + MAX_CLOCK_SKEW_MS + " ms");
        }
        for (String f : new String[]{threadField, timeField, callIdField}) {
            if (f != null && f.length() > MAX_FIELD) {
                throw new IllegalArgumentException("Field names are at most " + MAX_FIELD + " characters");
            }
        }
    }

    public static ProjectLogSettings defaults(String project) {
        return new ProjectLogSettings(project, List.of(), null, null, DEFAULT_CALL_ID_FIELD, DEFAULT_CLOCK_SKEW_MS);
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s.strip();
    }
}
