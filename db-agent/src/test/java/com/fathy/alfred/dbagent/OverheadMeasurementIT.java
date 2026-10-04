package com.fathy.alfred.dbagent;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * SC-002: what capture adds to a call. The same 50-statement call (reads that walk their rows, and writes) runs
 * 1,000 times with capture off for its project (db=0 - the agent is attached but records nothing) and 1,000 times
 * with it on, interleaved so JIT and GC hit both sides alike.
 *
 * <p>H2 in memory answers a statement in a few microseconds, so the RELATIVE overhead here is far above what a real
 * database shows (where one round trip is 0.3-5 ms): the assertion is on the absolute cost added per statement, and
 * the numbers printed are what docs/db-capture.md quotes. 50 µs per statement against a 1 ms query is the 5 % budget.
 */
class OverheadMeasurementIT {

    private static final int STATEMENTS_PER_CALL = 50;
    private static final int ITERATIONS = 1_000;
    private static Connection connection;

    @BeforeAll
    static void schema() throws Exception {
        AgentTestSupport.reset();
        connection = DriverManager.getConnection("jdbc:h2:mem:overhead;DB_CLOSE_DELAY=-1");
        try (Statement s = connection.createStatement()) {
            s.execute("CREATE TABLE wallet (id BIGINT PRIMARY KEY, user_id BIGINT, balance DECIMAL(12,2), currency VARCHAR(3))");
            for (int i = 0; i < 20; i++) {
                s.execute("INSERT INTO wallet VALUES (" + i + ", " + (i % 5) + ", 100.00, 'AED')");
            }
        }
    }

    private static void oneCall() throws Exception {
        for (int i = 0; i < STATEMENTS_PER_CALL; i++) {
            if (i % 5 == 4) {
                try (PreparedStatement ps = connection.prepareStatement("UPDATE wallet SET balance = balance - ? WHERE id = ?")) {
                    ps.setBigDecimal(1, java.math.BigDecimal.ONE);
                    ps.setLong(2, i % 20);
                    ps.executeUpdate();
                }
            } else {
                try (PreparedStatement ps = connection.prepareStatement("SELECT id, balance, currency FROM wallet WHERE user_id = ?")) {
                    ps.setLong(1, i % 5);
                    try (ResultSet rs = ps.executeQuery()) {
                        while (rs.next()) {
                            rs.getLong(1);
                            rs.getBigDecimal(2);
                            rs.getString(3);
                        }
                    }
                }
            }
        }
    }

    private static long timeCall(String callId, boolean db) throws Exception {
        long start = System.nanoTime();
        AgentTestSupport.inCall(callId, OverheadMeasurementIT::oneCall, db);
        return System.nanoTime() - start;
    }

    @Test
    void captureAddsLittleToEachStatement() throws Exception {
        for (int i = 0; i < 200; i++) { // warm up both paths
            timeCall("warm-off-" + i, false);
            timeCall("warm-on-" + i, true);
        }
        AgentTestSupport.reset();
        long off = 0;
        long on = 0;
        for (int i = 0; i < ITERATIONS; i++) {
            off += timeCall("off-" + i, false);
            on += timeCall("on-" + i, true);
            if (i % 100 == 99) {
                AgentTestSupport.reset(); // the collecting sink would otherwise grow without bound
            }
        }
        double offPerCallMicros = off / 1_000.0 / ITERATIONS;
        double onPerCallMicros = on / 1_000.0 / ITERATIONS;
        double addedPerStatementMicros = (onPerCallMicros - offPerCallMicros) / STATEMENTS_PER_CALL;
        System.out.printf("[overhead] %d-statement call, H2 in memory, %d iterations, Java %s: capture off %.1f us/call, on %.1f us/call,"
                        + " added %.2f us per statement%n", STATEMENTS_PER_CALL, ITERATIONS, System.getProperty("java.version"),
                offPerCallMicros, onPerCallMicros, addedPerStatementMicros);

        assertThat(addedPerStatementMicros).isLessThan(50.0);
    }
}
