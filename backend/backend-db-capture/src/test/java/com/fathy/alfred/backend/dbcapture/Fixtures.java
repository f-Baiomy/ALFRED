package com.fathy.alfred.backend.dbcapture;

import com.fathy.alfred.backend.dbcapture.domain.model.Column;
import com.fathy.alfred.backend.dbcapture.domain.model.IncomingStatement;
import com.fathy.alfred.backend.dbcapture.domain.model.OutcomeKind;
import com.fathy.alfred.backend.dbcapture.domain.model.StatementKind;
import com.fathy.alfred.backend.dbcapture.domain.model.StatementOutcome;
import com.fathy.alfred.backend.dbcapture.domain.model.TypedValue;

import java.util.ArrayList;
import java.util.List;

/** Statements shaped like the agent sends them (contracts/agent-ingest.md). */
public final class Fixtures {

    private Fixtures() {
    }

    public static StatementOutcome rows(List<Column> columns, long rowsRead) {
        return new StatementOutcome(OutcomeKind.ROWS, columns, rowsRead, false, false, null, null, null, null, null, null, null, null, null, null, null);
    }

    public static StatementOutcome updated(long affected) {
        return new StatementOutcome(OutcomeKind.UPDATED, null, null, null, null, affected, null, null, null, null, null, null, null, null, null, null);
    }

    public static StatementOutcome failed(String sqlState, int code, String message) {
        return new StatementOutcome(OutcomeKind.FAILED, null, null, null, null, null, null, null, null, sqlState, code, message, List.of(), null, null, null);
    }

    public static StatementOutcome txEnd(String result, long heldMicros) {
        return new StatementOutcome(OutcomeKind.TX_END, null, null, null, null, null, null, null, null, null, null, null, null, null, result, heldMicros);
    }

    public static IncomingStatement statement(String sid, String callId, int seq, StatementKind kind, String sql, StatementOutcome outcome,
                                              List<List<TypedValue>> rows, String txId) {
        return new IncomingStatement(sid, callId, null, "default task-14", seq, kind, sql, "fp-" + sql.hashCode(), tableOf(sql),
                List.of(List.of(TypedValue.of("BIGINT", "1042"))), outcome, rows, 0, null, null, "2026-10-04T18:02:43.205Z",
                1000L * seq, 3000L * seq, txId, "pool-3", "WalletRepository.lockByUser(WalletRepository.java:88)", "Oracle 19c", null, null);
    }

    public static IncomingStatement select(String sid, String callId, int seq, int rowCount) {
        List<List<TypedValue>> rows = new ArrayList<>();
        for (int i = 0; i < rowCount; i++) {
            rows.add(List.of(TypedValue.of("BIGINT", String.valueOf(i)), TypedValue.of("VARCHAR", "row " + i)));
        }
        return statement(sid, callId, seq, StatementKind.SELECT, "SELECT id, name FROM users WHERE id = ?",
                rows(List.of(new Column("id", "BIGINT"), new Column("name", "VARCHAR")), rowCount), rows, null);
    }

    private static String tableOf(String sql) {
        String[] words = sql.split("\\s+");
        for (int i = 0; i < words.length - 1; i++) {
            if (words[i].equalsIgnoreCase("FROM") || words[i].equalsIgnoreCase("INTO") || words[i].equalsIgnoreCase("UPDATE")) {
                return words[i + 1];
            }
        }
        return null;
    }
}
