package com.fathy.alfred.dbagent;

import com.fathy.alfred.dbagent.transport.StatementRecord;
import org.example.jta.FakeUserTransaction;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import javax.transaction.UserTransaction;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.Statement;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;

import static com.fathy.alfred.dbagent.AgentTestSupport.SINK;
import static com.fathy.alfred.dbagent.AgentTestSupport.inCall;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * Connection and transaction lifecycle: checkout, begin, commit and hand-back timed - and a container-managed (JTA)
 * transaction, which never calls Connection.commit, ends instead of staying "open" (every OdeySys transaction did).
 */
class ConnectionLifecycleIT {

    private JdbcDataSource dataSource;

    @BeforeEach
    void setUp() throws Exception {
        AgentTestSupport.reset();
        dataSource = new JdbcDataSource();
        dataSource.setURL("jdbc:h2:mem:" + UUID.randomUUID() + ";DB_CLOSE_DELAY=-1");
        try (Connection c = dataSource.getConnection(); Statement s = c.createStatement()) {
            s.execute("CREATE TABLE agency (id BIGINT PRIMARY KEY, name VARCHAR(20))");
        }
        AgentTestSupport.reset();
    }

    private List<StatementRecord> statements(String callId) {
        return SINK.statementsOf(callId).stream().sorted(Comparator.comparingInt(s -> s.seq)).collect(Collectors.toList());
    }

    @Test
    void aJtaCommitEndsTheTransactionTheConnectionNeverCommitted() throws Exception {
        UserTransaction tx = new FakeUserTransaction();
        inCall("jta-1", () -> {
            try (Connection c = dataSource.getConnection()) {
                c.setAutoCommit(false); // what the pool does when it enlists the connection
                try (PreparedStatement ps = c.prepareStatement("INSERT INTO agency VALUES (?, ?)")) {
                    ps.setLong(1, 1);
                    ps.setString(2, "Acme");
                    ps.executeUpdate();
                }
            } // closed (handed back) before the container commits
            tx.commit();
        }, true);
        List<StatementRecord> list = statements("jta-1");
        assertThat(list).extracting(s -> s.kind).containsExactly("INSERT", "COMMIT");
        StatementRecord insert = list.get(0);
        assertThat(insert.outcome.acquireMicros).isNotNull().isGreaterThanOrEqualTo(0L);
        StatementRecord commit = list.get(1);
        assertThat(commit.outcome.txResult).isEqualTo("COMMITTED");
        assertThat(commit.outcome.via).isEqualTo("JTA");
        assertThat(commit.outcome.beginMicros).isNotNull();
        assertThat(commit.outcome.closeMicros).isNotNull();
        assertThat(commit.outcome.commitMicros).isNotNull();
        assertThat(commit.txId).isEqualTo(insert.txId);
    }

    @Test
    void aJdbcCommitIsTimedToo_andAReusedThreadStartsClean() throws Exception {
        inCall("jdbc-1", () -> {
            try (Connection c = dataSource.getConnection()) {
                c.setAutoCommit(false);
                try (PreparedStatement ps = c.prepareStatement("UPDATE agency SET name = ? WHERE id = ?")) {
                    ps.setString(1, "x");
                    ps.setLong(2, 1);
                    ps.executeUpdate();
                }
                c.commit();
            }
        }, true);
        StatementRecord commit = statements("jdbc-1").get(1);
        assertThat(commit.outcome.via).isEqualTo("JDBC");
        assertThat(commit.outcome.commitMicros).isNotNull();
        assertThat(commit.outcome.beginMicros).isNotNull();

        // a transaction left open by one call is not ended by the next call's JTA commit on the same thread
        inCall("leak-1", () -> {
            Connection c = dataSource.getConnection();
            c.setAutoCommit(false);
            try (PreparedStatement ps = c.prepareStatement("SELECT name FROM agency WHERE id = ?")) {
                ps.setLong(1, 1);
                ps.executeQuery().close();
            }
        }, true);
        inCall("next-1", () -> new FakeUserTransaction().commit(), true);
        assertThat(statements("next-1")).isEmpty();
    }

    @Test
    void withIndexCheckOnTheFirstStatementOfATableCarriesItsIndexes() throws Exception {
        try (Connection c = dataSource.getConnection(); Statement st = c.createStatement()) {
            st.execute("CREATE INDEX ix_agency_name ON agency(name)");
        }
        AgentTestSupport.SETTINGS.apply(com.fathy.alfred.dbagent.transport.AgentSettings.DEFAULT_ROWS_PER_RESULT, java.util.Collections.emptySet(),
                false, false, java.util.Collections.singletonList("SELECT 1"), java.util.Collections.emptyList(), 3, true);
        inCall("ix-1", () -> {
            try (Connection c = dataSource.getConnection()) {
                for (int i = 0; i < 2; i++) {
                    try (PreparedStatement ps = c.prepareStatement("SELECT name FROM agency WHERE name = ?")) {
                        ps.setString(1, "Acme");
                        ps.executeQuery().close();
                    }
                }
            }
        }, true);
        List<StatementRecord> list = statements("ix-1");
        assertThat(list.get(0).indexes).extracting(ix -> ix.name.toUpperCase()).contains("IX_AGENCY_NAME");
        assertThat(list.get(0).indexes).anySatisfy(ix -> assertThat(ix.unique).isTrue()); // the primary key
        assertThat(list.get(1).indexes).isNull(); // once per table per call
        AgentTestSupport.reset();
    }
}
