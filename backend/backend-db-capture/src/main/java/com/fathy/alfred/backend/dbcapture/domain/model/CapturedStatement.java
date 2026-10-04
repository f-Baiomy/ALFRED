package com.fathy.alfred.backend.dbcapture.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

/**
 * One database operation inside a call (or in the outside-any-call bucket when {@code callId} is null) - the full
 * record, minus result rows. {@code seq} is the call's own order counter, shared with its supplier calls
 * (docs/db-capture.md), so it orders statements against HTTP exactly. {@code sql} keeps its placeholders and
 * {@code params} holds one list per batch set: together with {@code outcome}, {@code fingerprint} and
 * {@code runTag} that is what a later Relive version needs to answer this statement without the database
 * (FR-040..043) - nothing replays it today.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record CapturedStatement(
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
        long storedRows
) {
}
