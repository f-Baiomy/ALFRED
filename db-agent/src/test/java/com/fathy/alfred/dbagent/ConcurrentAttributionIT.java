package com.fathy.alfred.dbagent;

import com.fathy.alfred.dbagent.transport.StatementRecord;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static com.fathy.alfred.dbagent.AgentTestSupport.SINK;
import static org.assertj.core.api.Assertions.assertThat;

/** SC-001: with 50 calls running at once every statement belongs to the call that ran it - including async work. */
class ConcurrentAttributionIT {

    private String url;

    @BeforeEach
    void setUp() throws Exception {
        url = "jdbc:h2:mem:" + UUID.randomUUID() + ";DB_CLOSE_DELAY=-1";
        try (Connection c = DriverManager.getConnection(url); Statement s = c.createStatement()) {
            s.execute("CREATE TABLE t (call_id VARCHAR(40))");
        }
        AgentTestSupport.reset();
    }

    @Test
    void fiftyConcurrentCallsAreEachAttributedExactly() throws Exception {
        int calls = 50;
        ExecutorService requests = Executors.newFixedThreadPool(calls);
        ExecutorService async = Executors.newFixedThreadPool(4);
        CountDownLatch start = new CountDownLatch(1);
        List<Future<?>> done = new ArrayList<>();
        for (int i = 0; i < calls; i++) {
            String callId = "call-" + i;
            done.add(requests.submit(() -> {
                start.await();
                AgentTestSupport.inCall(callId, () -> {
                    for (int n = 0; n < 5; n++) {
                        write(callId);
                    }
                    // Work handed to another thread keeps the call.
                    async.submit(() -> {
                        write(callId);
                        return null;
                    }).get();
                    CompletableFuture.runAsync(() -> {
                        try {
                            write(callId);
                        } catch (Exception e) {
                            throw new IllegalStateException(e);
                        }
                    }).get();
                }, true);
                return null;
            }));
        }
        start.countDown();
        for (Future<?> f : done) {
            f.get(60, TimeUnit.SECONDS);
        }
        requests.shutdown();
        async.shutdown();

        List<StatementRecord> all = SINK.statements();
        assertThat(all).hasSize(calls * 7);
        for (StatementRecord r : all) {
            assertThat(r.callId).as("statement bound to %s", r.params.get(0).get(0).value).isEqualTo(r.params.get(0).get(0).value);
        }
        for (int i = 0; i < calls; i++) {
            String callId = "call-" + i;
            assertThat(SINK.statementsOf(callId)).extracting(r -> r.seq).containsExactlyInAnyOrder(1, 2, 3, 4, 5, 6, 7);
        }
    }

    private void write(String callId) throws Exception {
        try (Connection c = DriverManager.getConnection(url); PreparedStatement ps = c.prepareStatement("INSERT INTO t VALUES (?)")) {
            ps.setString(1, callId);
            ps.executeUpdate();
        }
    }

    @SuppressWarnings("unused")
    private void read() throws Exception {
        try (Connection c = DriverManager.getConnection(url); PreparedStatement ps = c.prepareStatement("SELECT * FROM t"); ResultSet rs = ps.executeQuery()) {
            while (rs.next()) {
                rs.getString(1);
            }
        }
    }
}
