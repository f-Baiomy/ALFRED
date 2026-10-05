package com.fathy.alfred.backend.triage.adapter.out.sqlite;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.triage.domain.model.CallAttention;
import com.fathy.alfred.backend.triage.domain.model.CallDirection;
import com.fathy.alfred.backend.triage.domain.model.SoftFailure;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

class SqliteAttentionRepositoryTest {

    @TempDir
    Path tempDir;

    private SqliteAttentionRepository repo;

    @BeforeEach
    void open() throws Exception {
        repo = new SqliteAttentionRepository(new ObjectMapper());
        Field field = SqliteAttentionRepository.class.getDeclaredField("dbFile");
        field.setAccessible(true);
        field.set(repo, tempDir.resolve("triage.db").toString());
        repo.init();
    }

    @AfterEach
    void close() throws InterruptedException {
        repo.close();
        Thread.sleep(50); // Windows releases the file handle a moment after the pool closes
    }

    static CallAttention row(String id, String project, String parent, Integer status, long startedAt, String state, int priority) {
        return new CallAttention(id, parent == null ? CallDirection.INBOUND : CallDirection.OUTBOUND, project, parent, "POST", "/x/" + id,
                status, null, startedAt, 12.5, state, null, List.of(), 0, 0, 0, priority);
    }

    @Test
    void aRowRoundTripsAndIsReplacedWhole() {
        CallAttention first = new CallAttention("c1", CallDirection.INBOUND, "odeysys", null, "GET", "/a", 200, null, 1000, null, "COMPLETED",
                new SoftFailure("xml-error", "322", "No availability"), List.of("offers", "a.items"), 2, 3, 1, 4);
        repo.save(first);
        assertThat(repo.find("c1")).contains(first);

        CallAttention second = row("c1", "odeysys", null, 500, 1000, "COMPLETED", 3);
        repo.save(second);
        assertThat(repo.find("c1")).contains(second);
        assertThat(repo.find("nope")).isEmpty();
        assertThat(repo.size()).isEqualTo(1);
    }

    @Test
    void childrenAndFindAllReadManyCallsAtOnce() {
        repo.save(row("p1", "odeysys", null, 200, 1000, "COMPLETED", 6));
        repo.save(row("p2", "odeysys", null, 200, 2000, "COMPLETED", 6));
        repo.save(row("k1", null, "p1", 503, 1100, "COMPLETED", 3));
        repo.save(row("k2", null, "p1", 200, 1200, "COMPLETED", 6));
        repo.save(row("k3", null, "p2", 200, 2100, "COMPLETED", 6));

        assertThat(repo.children(List.of("p1", "p2", "zz"))).extracting(CallAttention::callId).containsExactlyInAnyOrder("k1", "k2", "k3");
        assertThat(repo.findAll(List.of("p1", "k3", "zz"))).extracting(CallAttention::callId).containsExactlyInAnyOrder("p1", "k3");
    }

    @Test
    void liveListsCallsWithNoParentAtTheAskedPriority_newestFirst_plusHungCalls() {
        repo.save(row("a", "odeysys", null, 500, 1000, "COMPLETED", 3));
        repo.save(row("b", "odeysys", null, 200, 2000, "COMPLETED", 4));
        repo.save(row("c", "other", null, 404, 3000, "COMPLETED", 3));
        repo.save(row("d", "odeysys", null, 200, 4000, "COMPLETED", 6));
        repo.save(row("e", null, "a", 503, 1500, "COMPLETED", 3));            // a supplier call: under its parent, not on its own
        repo.save(row("f", "odeysys", null, null, 500, "IN_PROGRESS", 6));    // hung since 500

        assertThat(repo.live("odeysys", 0, 10_000, 5, 600, 50)).extracting(CallAttention::callId).containsExactly("b", "a", "f");
        assertThat(repo.live("odeysys", 0, 10_000, 3, 0, 50)).extracting(CallAttention::callId).containsExactly("a");
        assertThat(repo.live(null, 0, 10_000, 5, 0, 50)).extracting(CallAttention::callId).containsExactly("c", "b", "a");
        assertThat(repo.live(null, 0, 10_000, 6, 0, 50)).extracting(CallAttention::callId).containsExactly("d", "c", "b", "a", "f");
        assertThat(repo.live(null, 1500, 3500, 5, 0, 50)).extracting(CallAttention::callId).containsExactly("c", "b");
        assertThat(repo.live(null, 0, 10_000, 5, 0, 2)).extracting(CallAttention::callId).containsExactly("c", "b");
    }

    @Test
    void countsPerPriorityInTheWindow() {
        repo.save(row("a", "odeysys", null, 500, 1000, "COMPLETED", 3));
        repo.save(row("b", "odeysys", null, 500, 1100, "COMPLETED", 3));
        repo.save(row("c", "odeysys", null, 200, 1200, "COMPLETED", 6));
        repo.save(row("d", "other", null, 200, 1300, "COMPLETED", 4));
        repo.save(row("e", null, "a", 503, 1050, "COMPLETED", 3));

        assertThat(repo.counts("odeysys", 0, 5000)).containsExactlyInAnyOrderEntriesOf(java.util.Map.of(3, 2, 6, 1));
        assertThat(repo.counts(null, 0, 5000)).containsExactlyInAnyOrderEntriesOf(java.util.Map.of(3, 2, 4, 1, 6, 1));
    }

    @Test
    void deleteOldestKeepsWhatACycleHolds() {
        for (int i = 0; i < 10; i++) {
            repo.save(row("c" + i, "odeysys", null, 200, 1000 + i, "COMPLETED", 6));
        }
        assertThat(repo.deleteOldest(3, Set.of("c0"))).isEqualTo(3);
        assertThat(repo.find("c0")).isPresent();
        assertThat(repo.find("c1")).isEmpty();
        assertThat(repo.find("c3")).isEmpty();
        assertThat(repo.find("c4")).isPresent();
        assertThat(repo.size()).isEqualTo(7);
    }

    @Test
    void markers() {
        assertThat(repo.hasMarker("backfill-v1")).isFalse();
        repo.setMarker("backfill-v1", "now");
        assertThat(repo.hasMarker("backfill-v1")).isTrue();
    }

    @Test
    void everyTriageReadUsesItsIndex() throws Exception {
        try (Connection connection = DriverManager.getConnection("jdbc:sqlite:" + tempDir.resolve("triage.db"));
             Statement st = connection.createStatement()) {
            assertThat(plan(st, "SELECT call_id FROM call_attention WHERE parent_call_id IS NULL AND project = 'x' AND started_at BETWEEN 1 AND 2"
                    + " AND priority <= 5 AND priority <= 3 ORDER BY started_at DESC")).contains("ix_attention_project");
            assertThat(plan(st, "SELECT call_id FROM call_attention WHERE parent_call_id IS NULL AND started_at BETWEEN 1 AND 2"
                    + " AND priority <= 5 AND priority <= 3 ORDER BY started_at DESC")).contains("ix_attention_recent");
            assertThat(plan(st, "SELECT call_id FROM call_attention WHERE parent_call_id IS NOT NULL AND parent_call_id IN ('a','b')"))
                    .contains("ix_attention_parent");
            assertThat(plan(st, "SELECT call_id FROM call_attention WHERE state = 'IN_PROGRESS' AND started_at < 5")).contains("ix_attention_progress");
        }
    }

    private static String plan(Statement st, String sql) throws Exception {
        StringBuilder out = new StringBuilder();
        try (ResultSet rs = st.executeQuery("EXPLAIN QUERY PLAN " + sql)) {
            while (rs.next()) {
                out.append(rs.getString("detail")).append('\n');
            }
        }
        return out.toString();
    }
}
