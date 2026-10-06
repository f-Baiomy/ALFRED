package com.fathy.alfred.backend.triage.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

/**
 * A call's log and database signals beyond its status (specs/010-mcp-log-investigation), fed by db-capture through
 * backend-app: the ERROR / WARN lines and logged exceptions the agent caught for it, whether its lines were caught at
 * all ({@code logStatus} CAUGHT, or null when unknown), the Log level that applied to it, and the names of the
 * database flags raised for it (every flag the database window raises except failures, which triage counts itself).
 */
@JsonInclude(JsonInclude.Include.NON_EMPTY)
public record CallSignals(int logErrors, int logWarnings, int logExceptions, String logStatus, String logLevel, List<String> dbFlags) {

    public static final CallSignals NONE = new CallSignals(0, 0, 0, null, null, List.of());

    public CallSignals {
        dbFlags = dbFlags == null ? List.of() : List.copyOf(dbFlags);
    }
}
