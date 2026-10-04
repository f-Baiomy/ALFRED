package com.fathy.alfred.dbagent;

import com.fathy.alfred.dbagent.transport.StatementRecord;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.Collections;
import java.util.List;
import java.util.UUID;

import static com.fathy.alfred.dbagent.AgentTestSupport.SINK;
import static org.assertj.core.api.Assertions.assertThat;

/** Rows are recorded as the application reads them - never read ahead, chunked at 500, capped by the setting. */
class ResultSetCaptureIT {

    private String url;

    @BeforeEach
    void setUp() throws Exception {
        url = "jdbc:h2:mem:" + UUID.randomUUID() + ";DB_CLOSE_DELAY=-1";
        try (Connection c = DriverManager.getConnection(url); Statement s = c.createStatement()) {
            s.execute("CREATE TABLE tx (id BIGINT, amount DECIMAL(10,2), kind VARCHAR(10))");
            s.execute("INSERT INTO tx SELECT X, X * 1.5, CASE WHEN MOD(X, 3) = 0 THEN 'TOPUP' ELSE 'PAY' END FROM SYSTEM_RANGE(1, 1200)");
        }
        AgentTestSupport.reset();
    }

    @Test
    void stoppingEarlyIsPartialAndUnreadColumnsAreMarked() throws Exception {
        AgentTestSupport.inCall("call-partial", () -> {
            try (Connection c = DriverManager.getConnection(url); PreparedStatement ps = c.prepareStatement("SELECT id, amount, kind FROM tx ORDER BY id");
                 ResultSet rs = ps.executeQuery()) {
                for (int i = 0; i < 3 && rs.next(); i++) {
                    rs.getLong(1);
                    rs.getString("kind");
                }
            }
        }, true);
        StatementRecord r = SINK.statementsOf("call-partial").get(0);
        assertThat(r.outcome.rowsRead).isEqualTo(3);
        assertThat(r.outcome.partial).isTrue();
        assertThat(r.rows).hasSize(3);
        assertThat(r.rows.get(0).get(1).type).isEqualTo("NOT_READ");
        assertThat(r.rows.get(2).get(2).value).isEqualTo("TOPUP");
    }

    @Test
    void longResultsLeaveInChunksUnderOneSid() throws Exception {
        inCall("call-long", () -> readAll());
        List<StatementRecord> chunks = SINK.statementsOf("call-long");
        assertThat(chunks).extracting(r -> r.rowsFrom).containsExactly(0, 500, 1000);
        assertThat(chunks).extracting(r -> r.sid).containsOnly(chunks.get(0).sid);
        assertThat(chunks.get(2).rows).hasSize(200);
        assertThat(chunks.get(2).outcome.rowsRead).isEqualTo(1200);
        assertThat(chunks.get(2).outcome.partial).isFalse();
    }

    @Test
    void rowsPastTheLimitAreCountedNotKept() throws Exception {
        AgentTestSupport.SETTINGS.apply(10, Collections.emptySet(), false, true, Collections.singletonList("SELECT 1"));
        inCall("call-limit", () -> readAll());
        List<StatementRecord> chunks = SINK.statementsOf("call-limit");
        StatementRecord last = chunks.get(chunks.size() - 1);
        int stored = chunks.stream().mapToInt(r -> r.rows == null ? 0 : r.rows.size()).sum();
        assertThat(stored).isEqualTo(10);
        assertThat(last.outcome.rowsRead).isEqualTo(1200);
        assertThat(last.outcome.overLimit).isTrue();
    }

    private void inCall(String id, AgentTestSupport.ThrowingRunnable body) throws Exception {
        AgentTestSupport.inCall(id, body, true);
    }

    private void readAll() throws Exception {
        try (Connection c = DriverManager.getConnection(url); PreparedStatement ps = c.prepareStatement("SELECT id, amount, kind FROM tx ORDER BY id");
             ResultSet rs = ps.executeQuery()) {
            while (rs.next()) {
                rs.getLong(1);
                rs.getBigDecimal(2);
                rs.getString(3);
            }
        }
    }
}
