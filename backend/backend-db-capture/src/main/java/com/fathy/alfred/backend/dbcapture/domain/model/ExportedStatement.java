package com.fathy.alfred.backend.dbcapture.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

/**
 * A captured statement as it travels in a .json export and back in on re-import: the stored record, flat, plus every
 * stored row of its result and before-image - nothing cut (exports never truncate). Flat rather than wrapping
 * CapturedStatement so the same record reads the file back.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ExportedStatement(
        long id,
        String callId,
        String thread,
        int seq,
        StatementKind kind,
        String sql,
        String fingerprint,
        String table,
        List<List<TypedValue>> params,
        StatementOutcome outcome,
        String startedAt,
        long durationMicros,
        long offsetMicros,
        String txId,
        String connectionId,
        String codeLocation,
        String runTag,
        String dataSource,
        BeforeImage beforeImage,
        List<String> cascadesTo,
        boolean undone,
        boolean expected,
        long storedRows,
        List<List<TypedValue>> rows,
        List<List<TypedValue>> beforeImageRows,
        StatementOrigin origin,
        List<String> callers,
        List<TableIndex> indexes
) {
    public static ExportedStatement of(CapturedStatement s, List<List<TypedValue>> rows, List<List<TypedValue>> beforeImageRows) {
        return new ExportedStatement(s.id(), s.callId(), s.thread(), s.seq(), s.kind(), s.sql(), s.fingerprint(), s.table(), s.params(),
                s.outcome(), s.startedAt(), s.durationMicros(), s.offsetMicros(), s.txId(), s.connectionId(), s.codeLocation(), s.runTag(),
                s.dataSource(), s.beforeImage(), s.cascadesTo(), s.undone(), s.expected(), s.storedRows(),
                rows.isEmpty() ? null : rows, beforeImageRows.isEmpty() ? null : beforeImageRows, s.origin(), s.callers(), s.indexes());
    }
}
