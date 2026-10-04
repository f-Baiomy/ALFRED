package com.fathy.alfred.backend.dbcapture.domain.model;

import java.util.List;

/**
 * A statement as one agent batch delivers it - the stored record's fields plus the rows that came with it.
 * {@code sid} is the agent's own unique id for the statement ("agentId:n"): ingest is idempotent on it, and a long
 * result that arrives in several chunks ({@code rowsFrom} &gt; 0) is appended to the statement with the same sid.
 */
public record IncomingStatement(
        String sid,
        String callId,
        String runTag,
        String thread,
        int seq,
        StatementKind kind,
        String sql,
        String fingerprint,
        String table,
        List<List<TypedValue>> params,
        StatementOutcome outcome,
        List<List<TypedValue>> rows,
        int rowsFrom,
        List<List<TypedValue>> beforeImageRows,
        BeforeImage beforeImage,
        String startedAt,
        long durationMicros,
        long offsetMicros,
        String txId,
        String connectionId,
        String codeLocation,
        String dataSource,
        List<String> cascadesTo
) {
}
