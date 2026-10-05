package com.fathy.alfred.backend.dbcapture.domain;

import com.fathy.alfred.backend.dbcapture.domain.model.CallMarker;
import com.fathy.alfred.backend.dbcapture.domain.model.CapturedStatement;
import com.fathy.alfred.backend.dbcapture.domain.model.DbCaptureSettings;
import com.fathy.alfred.backend.dbcapture.domain.model.DbFlag;
import com.fathy.alfred.backend.dbcapture.domain.model.DbFlagType;
import com.fathy.alfred.backend.dbcapture.domain.model.MarkerType;
import com.fathy.alfred.backend.dbcapture.domain.model.OutcomeKind;
import com.fathy.alfred.backend.dbcapture.domain.model.StatementKind;
import com.fathy.alfred.backend.dbcapture.domain.model.StatementOutcome;
import com.fathy.alfred.backend.dbcapture.domain.model.StatementTransaction;
import com.fathy.alfred.backend.dbcapture.domain.model.Thresholds;
import com.fathy.alfred.backend.dbcapture.domain.model.TypedValue;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * SC-007 over a reference recording shaped like the mock's "pay" call: every problem that is present is raised, and
 * a clean call raises nothing.
 */
class StatementFlagsTest {

    private static StatementOutcome outcome(OutcomeKind kind, Long rowsRead, Long affected, String message, Boolean swallowed) {
        return new StatementOutcome(kind, null, rowsRead, null, null, affected, null, null, null,
                kind == OutcomeKind.FAILED ? "23000" : null, null, message, null, swallowed, null, null);
    }

    private static CapturedStatement stmt(int seq, StatementKind kind, String sql, StatementOutcome outcome, long micros, String tx, String param) {
        return new CapturedStatement(seq, "c1", "default task-1", seq, kind, sql, "fp-" + sql.hashCode(), "t",
                List.of(List.of(TypedValue.of("BIGINT", param))), outcome, "2026-10-04T18:00:00Z", micros, seq * 1000L, tx, "pool-1",
                null, null, null, null, null, false, false, 0, null);
    }

    private static CapturedStatement select(int seq, String sql, long rows, long micros, String param) {
        return stmt(seq, StatementKind.SELECT, sql, outcome(OutcomeKind.ROWS, rows, null, null, null), micros, null, param);
    }

    private static List<DbFlagType> types(List<DbFlag> flags) {
        return flags.stream().map(DbFlag::type).toList();
    }

    @Test
    void raisesEveryProblemPresentInTheReferenceCall() {
        List<CapturedStatement> s = new ArrayList<>();
        int seq = 1;
        for (int i = 0; i < 12; i++) {
            s.add(select(seq++, "SELECT rule, fee FROM fare_rules WHERE route_id = ?", 2, 900, String.valueOf(500 + i)));
        }
        s.add(select(seq++, "SELECT id, amount FROM transactions WHERE user_id = ?", 2431, 48_200, "1042"));       // slow + huge
        int lockSeq = seq;
        s.add(stmt(seq++, StatementKind.SELECT, "SELECT balance FROM wallet WHERE user_id = ? FOR UPDATE",
                outcome(OutcomeKind.ROWS, 1L, null, null, null), 6200, "tx-7", "1042"));
        int supplierSeq = seq++;
        s.add(stmt(seq++, StatementKind.UPDATE, "UPDATE wallet SET balance = ? WHERE user_id = ?", outcome(OutcomeKind.UPDATED, null, 1L, null, null), 4800, "tx-7", "380"));
        int commitSeq = seq;
        s.add(stmt(seq++, StatementKind.COMMIT, "COMMIT", outcome(OutcomeKind.TX_END, null, null, null, null), 2600, "tx-7", null));
        int failSeq = seq;
        s.add(stmt(seq++, StatementKind.INSERT, "INSERT INTO loyalty_points VALUES (?)", outcome(OutcomeKind.FAILED, null, null,
                "ORA-00001: unique constraint violated", true), 3100, "tx-9", "12"));
        s.add(stmt(seq++, StatementKind.ROLLBACK, "ROLLBACK", outcome(OutcomeKind.TX_END, null, null, null, null), 1200, "tx-9", null));
        int noWhereSeq = seq;
        s.add(stmt(seq++, StatementKind.DELETE, "DELETE FROM rate_cache -- WHERE nothing", outcome(OutcomeKind.UPDATED, null, 212L, null, null), 9700, null, null));
        for (int i = 0; i < 20; i++) {
            s.add(select(seq++, "SELECT text FROM i18n_messages WHERE msg_key = ?", 1, 600, "pay.ok"));
        }
        List<StatementTransaction> txs = List.of(
                new StatementTransaction("c1", "tx-7", "pool-3", lockSeq, commitSeq, "COMMITTED", 348_000, 3, 1),
                new StatementTransaction("c1", "tx-9", "pool-2", failSeq, failSeq + 1, "ROLLED_BACK", 16_000, 2, 1));
        List<CallMarker> markers = List.of(new CallMarker("c1", supplierSeq, MarkerType.HTTP_OUT, null, "POST", "https://pay.supplier.com/v1/charge"));

        List<DbFlag> flags = StatementFlags.compute(s, txs, markers, DbCaptureSettings.defaults());

        assertThat(types(flags)).containsExactly(DbFlagType.NO_WHERE, DbFlagType.FAILED_SWALLOWED, DbFlagType.ROLLED_BACK,
                DbFlagType.LOCK_DURING_SUPPLIER_CALL, DbFlagType.LARGE_DELETE, DbFlagType.BEFORE_NOT_CAPTURED, DbFlagType.REPEATED_QUERY,
                DbFlagType.REPEATED_QUERY, DbFlagType.SLOW, DbFlagType.HUGE_RESULT);
        assertThat(flags.get(0).seqs()).containsExactly(noWhereSeq);
        assertThat(flags.get(0).severity()).isEqualTo(DbFlag.BAD);
        assertThat(flags.get(1).seqs()).containsExactly(failSeq);
        assertThat(flags.get(3).seqs()).containsExactly(supplierSeq);
        assertThat(flags.get(5).detail()).containsEntry("count", "2").containsEntry("deletes", "1").containsEntry("updates", "1");
        assertThat(flags.get(6).detail()).containsEntry("count", "12").containsEntry("cacheable", "false");
        assertThat(flags.get(7).detail()).containsEntry("count", "20").containsEntry("cacheable", "true");
        assertThat(flags.get(9).detail()).containsEntry("rows", "2,431");
    }

    @Test
    void aCleanCallRaisesNothing_andExpectedOrBelowThresholdStaysQuiet() {
        List<CapturedStatement> s = new ArrayList<>();
        s.add(select(1, "SELECT id FROM users WHERE id = ?", 1, 900, "1"));
        s.add(stmt(2, StatementKind.DELETE, "DELETE FROM cart_items WHERE user_id = 'x' AND note = 'no where here'",
                outcome(OutcomeKind.UPDATED, null, 3L, null, null), 1000, null, "1"));
        for (int i = 0; i < 4; i++) {
            s.add(select(3 + i, "SELECT rule FROM fare_rules WHERE route_id = ?", 1, 500, String.valueOf(i)));
        }
        // The delete read nothing first, so that is the one flag: its rows were not captured.
        assertThat(types(StatementFlags.compute(s, List.of(), List.of(), DbCaptureSettings.defaults()))).containsExactly(DbFlagType.BEFORE_NOT_CAPTURED);

        CapturedStatement truncate = stmt(9, StatementKind.DELETE, "DELETE FROM rate_cache", outcome(OutcomeKind.UPDATED, null, 212L, null, null), 1000, null, null);
        DbCaptureSettings expected = new DbCaptureSettings(50_000, List.of(), true, Thresholds.DEFAULTS, List.of(truncate.fingerprint()), List.of());
        assertThat(StatementFlags.compute(List.of(truncate), List.of(), List.of(), expected)).isEmpty();
    }

    @Test
    void aCascadeIsFlagged_andAWriteWithKnownBeforeRowsIsNot() {
        CapturedStatement delete = new CapturedStatement(1, "c1", "t", 1, StatementKind.DELETE, "DELETE FROM payment_holds WHERE id = ?", "fp", "payment_holds",
                List.of(List.of(TypedValue.of("BIGINT", "7712"))), outcome(OutcomeKind.UPDATED, null, 1L, null, null), "2026-10-04T18:00:00Z", 100, 100,
                null, null, null, null, null, new com.fathy.alfred.backend.dbcapture.domain.model.BeforeImage("AGENT_READ", null, 800L, null, 1, List.of()),
                List.of("hold_items"), false, false, 0, null);
        List<DbFlag> flags = StatementFlags.compute(List.of(delete), List.of(), List.of(), DbCaptureSettings.defaults());
        assertThat(types(flags)).containsExactly(DbFlagType.CASCADE);
        assertThat(flags.get(0).detail()).containsEntry("table", "payment_holds").containsEntry("children", "hold_items");
    }

    @Test
    void anUnswallowedFailureIsPlainFailed_andAFloodIsCapped() {
        List<CapturedStatement> s = new ArrayList<>();
        for (int i = 0; i < 50; i++) {
            s.add(select(i + 1, "SELECT x" + i + " FROM big", 5_000, 30_000, "1"));
        }
        s.add(stmt(60, StatementKind.INSERT, "INSERT INTO t VALUES (?)", outcome(OutcomeKind.FAILED, null, null, "boom", null), 1000, null, "1"));
        List<DbFlag> flags = StatementFlags.compute(s, List.of(), List.of(), DbCaptureSettings.defaults());
        assertThat(types(flags)).contains(DbFlagType.FAILED).doesNotContain(DbFlagType.FAILED_SWALLOWED);
        assertThat(flags.stream().filter(f -> f.type() == DbFlagType.SLOW)).hasSize(StatementFlags.MAX_PER_TYPE);
    }
}
