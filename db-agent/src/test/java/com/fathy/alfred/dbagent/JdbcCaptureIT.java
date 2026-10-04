package com.fathy.alfred.dbagent;

import com.fathy.alfred.dbagent.transport.MarkerRecord;
import com.fathy.alfred.dbagent.transport.StatementRecord;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.sql.CallableStatement;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Savepoint;
import java.sql.Statement;
import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;

import static com.fathy.alfred.dbagent.AgentTestSupport.SINK;
import static com.fathy.alfred.dbagent.AgentTestSupport.inCall;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** The agent recording real JDBC (H2) inside a call opened through the instrumented servlet entry. */
class JdbcCaptureIT {

    private String url;

    @BeforeEach
    void setUp() throws Exception {
        AgentTestSupport.reset();
        url = "jdbc:h2:mem:" + UUID.randomUUID() + ";DB_CLOSE_DELAY=-1";
        try (Connection c = DriverManager.getConnection(url); Statement s = c.createStatement()) {
            s.execute("CREATE TABLE wallet (user_id BIGINT PRIMARY KEY, balance DECIMAL(10,2), currency VARCHAR(3))");
            s.execute("CREATE TABLE payments (id BIGINT AUTO_INCREMENT PRIMARY KEY, user_id BIGINT, amount DECIMAL(10,2), ref VARCHAR(20) UNIQUE)");
            s.execute("INSERT INTO wallet VALUES (1042, 500.00, 'AED')");
        }
        AgentTestSupport.reset();
    }

    @Test
    void recordsEachStatementWithParamsResultTimingAndOrder() throws Exception {
        inCall("call-1", () -> {
            try (Connection c = DriverManager.getConnection(url)) {
                try (PreparedStatement ps = c.prepareStatement("SELECT balance, currency FROM wallet WHERE user_id = ?")) {
                    ps.setLong(1, 1042L);
                    try (ResultSet rs = ps.executeQuery()) {
                        while (rs.next()) {
                            rs.getBigDecimal("balance");
                            rs.getString(2);
                        }
                    }
                }
                try (PreparedStatement ps = c.prepareStatement("UPDATE wallet SET balance = ? WHERE user_id = ?")) {
                    ps.setBigDecimal(1, new BigDecimal("380.00"));
                    ps.setLong(2, 1042L);
                    ps.executeUpdate();
                }
            }
        }, true);

        List<StatementRecord> records = SINK.statementsOf("call-1");
        assertThat(records).extracting(r -> r.seq).containsExactly(1, 2);
        StatementRecord select = records.get(0);
        assertThat(select.kind).isEqualTo("SELECT");
        assertThat(select.table).isEqualToIgnoringCase("wallet");
        assertThat(select.params.get(0)).extracting(v -> v.value).containsExactly("1042");
        assertThat(select.outcome.kind).isEqualTo("ROWS");
        assertThat(select.outcome.rowsRead).isEqualTo(1);
        assertThat(select.outcome.partial).isFalse();
        assertThat(select.rows).hasSize(1);
        assertThat(select.rows.get(0)).extracting(v -> v.value).containsExactly("500.00", "AED");
        assertThat(select.outcome.columns).extracting(c -> c[0].toLowerCase()).containsExactly("balance", "currency");
        assertThat(select.codeLocation).contains("JdbcCaptureIT");
        assertThat(select.dataSource).contains("H2");
        StatementRecord update = records.get(1);
        assertThat(update.kind).isEqualTo("UPDATE");
        assertThat(update.outcome.affected).isEqualTo(1L);
        assertThat(update.params.get(0)).extracting(v -> v.value).containsExactly("380.00", "1042");
        assertThat(SINK.markers()).extracting(m -> m.type + ":" + m.seq).contains("CALL_OPEN:0");
    }

    @Test
    void dbZeroAndNoCallCaptureNothingUntilOutsideCaptureIsOn() throws Exception {
        inCall("call-off", () -> query(), false);
        query();
        assertThat(SINK.statements()).isEmpty();

        AgentTestSupport.SETTINGS.apply(50_000, java.util.Collections.emptySet(), true, true, java.util.Collections.singletonList("SELECT 1"));
        query();
        AgentTestSupport.DISPATCHER.flushStale();
        assertThat(SINK.statements()).hasSize(1);
        assertThat(SINK.statements().get(0).callId).isNull();
    }

    @Test
    void transactionsCommitRollbackAndSavepoints() throws Exception {
        inCall("call-tx", () -> {
            try (Connection c = DriverManager.getConnection(url)) {
                c.setAutoCommit(false);
                insert(c, "R1");
                c.commit();
                insert(c, "R2");
                Savepoint sp = c.setSavepoint();
                insert(c, "R3");
                c.rollback(sp);
                c.rollback();
                c.setAutoCommit(true);
            }
        }, true);

        List<String> lines = SINK.statementsOf("call-tx").stream().sorted((a, b) -> Integer.compare(a.seq, b.seq))
                .map(r -> r.kind + "/" + r.txId + (r.outcome.txResult == null ? "" : "/" + r.outcome.txResult)).collect(Collectors.toList());
        assertThat(lines).containsExactly("INSERT/tx-1", "COMMIT/tx-1/COMMITTED", "INSERT/tx-2", "SAVEPOINT/tx-2/SAVEPOINT",
                "INSERT/tx-2", "ROLLBACK_TO_SAVEPOINT/tx-2/ROLLED_BACK_TO_SAVEPOINT", "ROLLBACK/tx-2/ROLLED_BACK");
    }

    @Test
    void failuresCarryTheDatabaseError() throws Exception {
        inCall("call-fail", () -> {
            try (Connection c = DriverManager.getConnection(url)) {
                insert(c, "SAME");
                assertThatThrownBy(() -> insert(c, "SAME")).isInstanceOf(SQLException.class);
            }
        }, true);
        StatementRecord failed = SINK.statementsOf("call-fail").stream().filter(r -> "FAILED".equals(r.outcome.kind)).findFirst().orElseThrow(AssertionError::new);
        assertThat(failed.outcome.sqlState).isEqualTo("23505");
        assertThat(failed.outcome.message).containsIgnoringCase("unique");
    }

    @Test
    void batchesKeepEveryParameterSetAndGeneratedKeysAreRead() throws Exception {
        inCall("call-batch", () -> {
            try (Connection c = DriverManager.getConnection(url);
                 PreparedStatement ps = c.prepareStatement("INSERT INTO payments (user_id, amount, ref) VALUES (?, ?, ?)", Statement.RETURN_GENERATED_KEYS)) {
                for (int i = 1; i <= 2; i++) {
                    ps.setLong(1, 1042L);
                    ps.setBigDecimal(2, new BigDecimal("120.00"));
                    ps.setString(3, "B" + i);
                    ps.addBatch();
                }
                ps.executeBatch();
                try (ResultSet keys = ps.getGeneratedKeys()) {
                    while (keys.next()) {
                        keys.getLong(1);
                    }
                }
            }
        }, true);
        StatementRecord batch = SINK.statementsOf("call-batch").get(0);
        assertThat(batch.params).hasSize(2);
        assertThat(batch.params.get(1)).extracting(v -> v.value).containsExactly("1042", "120.00", "B2");
        assertThat(batch.outcome.perSet).hasSize(2);
        assertThat(batch.outcome.affected).isEqualTo(2L);
        assertThat(batch.outcome.generatedKeys).hasSize(2);
    }

    @Test
    void outsideACallTheHeaderIsAlsoNeeded() throws Exception {
        inCall("garbage-header", () -> query());
        assertThat(SINK.statements()).isEmpty();
        assertThat(SINK.markers()).isEmpty();
    }

    @Test
    void callableStatementsRecordTheirOutParameters() throws Exception {
        try (Connection c = DriverManager.getConnection(url); Statement s = c.createStatement()) {
            s.execute("CREATE ALIAS IF NOT EXISTS FEE FOR \"java.lang.Math.abs(int)\"");
        }
        AgentTestSupport.reset();
        inCall("call-proc", () -> {
            try (Connection c = DriverManager.getConnection(url); CallableStatement cs = c.prepareCall("{? = call FEE(?)}")) {
                cs.registerOutParameter(1, java.sql.Types.INTEGER);
                cs.setInt(2, -7);
                cs.execute();
                cs.getInt(1);
            }
        }, true);
        StatementRecord call = SINK.statementsOf("call-proc").get(0);
        assertThat(call.kind).isEqualTo("CALL");
        assertThat(call.table).isEqualToIgnoringCase("FEE");
    }

    private void query() throws SQLException {
        try (Connection c = DriverManager.getConnection(url); PreparedStatement ps = c.prepareStatement("SELECT currency FROM wallet")) {
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    rs.getString(1);
                }
            }
        }
    }

    private static void insert(Connection c, String ref) throws SQLException {
        try (PreparedStatement ps = c.prepareStatement("INSERT INTO payments (user_id, amount, ref) VALUES (?, ?, ?)")) {
            ps.setLong(1, 1042L);
            ps.setBigDecimal(2, new BigDecimal("1.00"));
            ps.setString(3, ref);
            ps.executeUpdate();
        }
    }

    static List<MarkerRecord> markersOf(String callId) {
        return SINK.markers().stream().filter(m -> callId.equals(m.callId)).collect(Collectors.toList());
    }
}
