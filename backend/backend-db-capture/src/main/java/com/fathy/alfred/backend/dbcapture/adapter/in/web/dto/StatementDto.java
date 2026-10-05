package com.fathy.alfred.backend.dbcapture.adapter.in.web.dto;

import com.fathy.alfred.backend.dbcapture.domain.model.BeforeImage;
import com.fathy.alfred.backend.dbcapture.domain.model.IncomingStatement;
import com.fathy.alfred.backend.dbcapture.domain.model.StatementKind;
import com.fathy.alfred.backend.dbcapture.domain.model.StatementOrigin;
import com.fathy.alfred.backend.dbcapture.domain.model.StatementOutcome;
import com.fathy.alfred.backend.dbcapture.domain.model.TypedValue;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

import java.util.List;

/** One statement in an agent batch (contracts/agent-ingest.md). Unknown fields are ignored, so a newer agent can send more. */
public record StatementDto(
        @NotBlank @Size(max = 200) String sid,
        @Size(max = 200) String callId,
        @Size(max = 400) String runTag,
        @NotBlank @Size(max = 500) String thread,
        @Min(0) int seq,
        @NotNull StatementKind kind,
        @NotNull @Size(max = 1_000_000) String sql,
        @Size(max = 200) String fingerprint,
        @Size(max = 300) String table,
        List<List<TypedValue>> params,
        @NotNull StatementOutcome outcome,
        @Size(max = 1_000_000) List<List<TypedValue>> rows,
        @Min(0) int rowsFrom,
        @Size(max = 1_000_000) List<List<TypedValue>> beforeImageRows,
        BeforeImage beforeImage,
        @Size(max = 64) String startedAt,
        @Min(0) long durationMicros,
        @Min(0) long offsetMicros,
        @Size(max = 100) String txId,
        @Size(max = 200) String connectionId,
        @Size(max = 1000) String codeLocation,
        @Size(max = 300) String dataSource,
        @Size(max = 200) List<String> cascadesTo,
        StatementOrigin origin,
        @Size(max = 20) List<@Size(max = 1000) String> callers
) {
    public IncomingStatement toDomain() {
        return new IncomingStatement(sid, blankToNull(callId), blankToNull(runTag), thread, seq, kind, sql, fingerprint, table, params,
                outcome, rows, rowsFrom, beforeImageRows, beforeImage, startedAt, durationMicros, offsetMicros, txId, connectionId,
                codeLocation, dataSource, cascadesTo, origin, callers == null || callers.isEmpty() ? null : callers);
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value;
    }
}
