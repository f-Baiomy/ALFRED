package com.fathy.alfred.dbagent;

import com.fathy.alfred.dbagent.sql.WriteShape;
import com.fathy.alfred.dbagent.transport.AgentSettings;
import com.fathy.alfred.dbagent.transport.StatementRecord;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.UUID;

import static com.fathy.alfred.dbagent.AgentTestSupport.SETTINGS;
import static com.fathy.alfred.dbagent.AgentTestSupport.SINK;
import static com.fathy.alfred.dbagent.AgentTestSupport.inCall;
import static org.assertj.core.api.Assertions.assertThat;

/** The opt-in before-image (FR-018) and cascade detection, against H2. */
class BeforeImageIT {

    private String url;

    @BeforeEach
    void setUp() throws Exception {
        AgentTestSupport.reset();
        url = "jdbc:h2:mem:" + UUID.randomUUID() + ";DB_CLOSE_DELAY=-1";
        try (Connection c = DriverManager.getConnection(url); Statement s = c.createStatement()) {
            s.execute("CREATE TABLE payment_holds (id BIGINT PRIMARY KEY, payment_id BIGINT, amount DECIMAL(10,2), reason VARCHAR(30))");
            s.execute("CREATE TABLE hold_items (id BIGINT PRIMARY KEY, hold_id BIGINT REFERENCES payment_holds(id) ON DELETE CASCADE)");
            s.execute("CREATE TABLE cart_items (id BIGINT PRIMARY KEY, user_id BIGINT, sku VARCHAR(20))");
            s.execute("INSERT INTO payment_holds VALUES (7712, 99817, 120.00, 'PENDING_CHARGE'), (7713, 99818, 5.00, 'OTHER')");
            s.execute("INSERT INTO hold_items VALUES (1, 7712)");
            s.execute("INSERT INTO cart_items VALUES (5501, 1042, 'TOPUP-120'), (5502, 1042, 'FEE-AED')");
        }
        AgentTestSupport.reset();
        SETTINGS.apply(AgentSettings.DEFAULT_ROWS_PER_RESULT, new HashSet<>(Arrays.asList("payment_holds")), false, false,
                Collections.singletonList("SELECT 1"));
    }

    @AfterEach
    void tearDown() {
        AgentTestSupport.reset();
    }

    @Test
    void readsTheRowsADeleteRemovesInTheSameTransaction_onlyForOptedTables() throws Exception {
        inCall("call-bi", () -> {
            try (Connection c = DriverManager.getConnection(url)) {
                c.setAutoCommit(false);
                try (PreparedStatement ps = c.prepareStatement("DELETE FROM payment_holds WHERE payment_id = ? AND reason <> 'x;?'")) {
                    ps.setLong(1, 99817L);
                    ps.executeUpdate();
                }
                try (PreparedStatement ps = c.prepareStatement("DELETE FROM cart_items WHERE user_id = ?")) {
                    ps.setLong(1, 1042L);
                    ps.executeUpdate();
                }
                c.commit();
            }
        }, true);

        List<StatementRecord> records = SINK.statementsOf("call-bi");
        assertThat(records).extracting(r -> r.kind).containsExactly("DELETE", "DELETE", "COMMIT");
        StatementRecord holds = records.get(0);
        assertThat(holds.beforeImage.source).isEqualTo("AGENT_READ");
        assertThat(holds.beforeImage.rowCount).isEqualTo(1);
        assertThat(holds.beforeImageRows).hasSize(1);
        assertThat(holds.beforeImageRows.get(0)).extracting(v -> v.value).containsExactly("7712", "99817", "120.00", "PENDING_CHARGE");
        assertThat(holds.beforeImage.columns).extracting(col -> col[0].toLowerCase()).containsExactly("id", "payment_id", "amount", "reason");
        assertThat(holds.beforeImage.extraReadMicros).isNotNull();
        assertThat(holds.cascadesTo).containsExactly("hold_items");
        assertThat(holds.outcome.affected).isEqualTo(1L); // the delete itself still did its work

        StatementRecord cart = records.get(1);
        assertThat(cart.beforeImage).isNull(); // not opted in: the agent never reads it
        assertThat(cart.cascadesTo).isNull();

        // The agent's own SELECT was never recorded as a statement of the call.
        assertThat(records).noneMatch(r -> r.sql.startsWith("SELECT * FROM"));
    }

    @Test
    void anUpdateReadsItsRowsWithTheWhereParameters_andComplexStatementsAreSkippedWithAReason() throws Exception {
        inCall("call-up", () -> {
            try (Connection c = DriverManager.getConnection(url)) {
                try (PreparedStatement ps = c.prepareStatement("UPDATE payment_holds h SET amount = ?, reason = ? WHERE h.id = ?")) {
                    ps.setBigDecimal(1, new java.math.BigDecimal("1.00"));
                    ps.setString(2, "CHANGED");
                    ps.setLong(3, 7713L);
                    ps.executeUpdate();
                }
                try (Statement s = c.createStatement()) {
                    s.executeUpdate("DELETE FROM payment_holds WHERE id IN (SELECT hold_id FROM hold_items)");
                }
                try (PreparedStatement ps = c.prepareStatement("SELECT amount FROM payment_holds WHERE id = 7713");
                     ResultSet rs = ps.executeQuery()) {
                    rs.next();
                    assertThat(rs.getBigDecimal(1)).isEqualByComparingTo("1.00");
                }
            }
        }, true);

        List<StatementRecord> records = SINK.statementsOf("call-up");
        StatementRecord update = records.get(0);
        assertThat(update.beforeImageRows.get(0)).extracting(v -> v.value).containsExactly("7713", "99818", "5.00", "OTHER");
        StatementRecord complex = records.get(1);
        assertThat(complex.beforeImage.source).isEqualTo("NONE");
        assertThat(complex.beforeImage.skippedReason).contains("too complex");
    }

    @Test
    void shapesSplitTheWhereAndItsParameters() {
        WriteShape w = WriteShape.of("UPDATE wallet w SET balance = ?, note = '?' WHERE w.user_id = ? AND version = ?").shape;
        assertThat(w.fromClause).isEqualTo("wallet w");
        assertThat(w.where).isEqualTo("w.user_id = ? AND version = ?");
        assertThat(w.firstWhereParam).isEqualTo(1);
        assertThat(w.whereParamCount).isEqualTo(2);
        assertThat(WriteShape.of("DELETE FROM rate_cache").reason).contains("no WHERE");
        assertThat(WriteShape.of("DELETE FROM a USING b WHERE a.id = b.id").reason).contains("too complex");
        assertThat(WriteShape.of("UPDATE a SET x = 1 FROM b WHERE a.id = b.id").reason).contains("FROM");
        assertThat(WriteShape.of("DELETE FROM t WHERE note = 'JOIN LIMIT'").shape).isNotNull();
    }
}
