package com.fathy.alfred.backend.dbcapture.adapter.out.sqlite;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.dbcapture.Fixtures;
import com.fathy.alfred.backend.dbcapture.domain.model.CapturedStatement;
import com.fathy.alfred.backend.dbcapture.domain.model.DbCaptureSettings;
import com.fathy.alfred.backend.dbcapture.domain.model.IncomingStatement;
import com.fathy.alfred.backend.dbcapture.domain.model.TraceHit;
import com.fathy.alfred.backend.dbcapture.domain.model.TypedValue;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Path;
import java.sql.DriverManager;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/** Result rows in compressed blocks, repeated text stored once, and the one-time wipe of an older file. */
class SqliteDbCaptureCompactStorageTest {

    @TempDir
    Path tempDir;

    private SqliteDbCaptureRepository repo;

    @BeforeEach
    void open() throws Exception {
        repo = new SqliteDbCaptureRepository(new ObjectMapper().findAndRegisterModules());
        Field field = SqliteDbCaptureRepository.class.getDeclaredField("dbFile");
        field.setAccessible(true);
        field.set(repo, file().toString());
        repo.init();
    }

    @AfterEach
    void close() throws InterruptedException {
        repo.close();
        Thread.sleep(50); // Windows releases the file handle a moment after the pool closes
    }

    private Path file() {
        return tempDir.resolve("db-capture.db");
    }

    private long statementId(String callId) {
        return repo.allStatements(callId, 10).get(0).id();
    }

    /** The agent's continuation chunk of a long result: rows {@code from..to-1}, same sid. */
    private static IncomingStatement chunk(IncomingStatement s, int from, int to) {
        return new IncomingStatement(s.sid(), s.callId(), s.runTag(), s.thread(), s.seq(), s.kind(), s.sql(), s.fingerprint(), s.table(),
                s.params(), s.outcome(), s.rows().subList(from, to), from, null, null, s.startedAt(), s.durationMicros(), s.offsetMicros(),
                s.txId(), s.connectionId(), s.codeLocation(), s.dataSource(), s.cascadesTo(), s.origin(), s.callers(), s.indexes());
    }

    private long count(String sql) throws Exception {
        try (var c = DriverManager.getConnection("jdbc:sqlite:" + file()); var st = c.createStatement(); var rs = st.executeQuery(sql)) {
            rs.next();
            return rs.getLong(1);
        }
    }

    @Test
    void aPageIsReadAcrossBlockBoundaries() throws Exception {
        repo.saveStatements(List.of(Fixtures.select("a:1", "call-1", 1, 250)));
        long id = statementId("call-1");

        assertThat(repo.rowCount(id, "RESULT")).isEqualTo(250);
        assertThat(repo.rows(id, "RESULT", 95, 10)).extracting(r -> r.get(0).value())
                .containsExactly("95", "96", "97", "98", "99", "100", "101", "102", "103", "104");
        assertThat(repo.rows(id, "RESULT", 200, 100)).hasSize(50);
        assertThat(repo.rows(id, "RESULT", 250, 100)).isEmpty();
        assertThat(count("SELECT COUNT(*) FROM row_blocks")).isEqualTo(3);
    }

    @Test
    void rowsArrivingInChunksFillTheLastBlockAndARetryChangesNothing() {
        IncomingStatement whole = Fixtures.select("a:1", "call-1", 1, 250);
        repo.saveStatements(List.of(chunk(whole, 0, 150)));
        repo.saveStatements(List.of(chunk(whole, 150, 250)));
        repo.saveStatements(List.of(chunk(whole, 150, 250)));
        long id = statementId("call-1");

        assertThat(repo.rowCount(id, "RESULT")).isEqualTo(250);
        List<List<TypedValue>> all = repo.rows(id, "RESULT", 0, 1000);
        assertThat(all).hasSize(250);
        for (int i = 0; i < all.size(); i++) {
            assertThat(all.get(i).get(1).value()).isEqualTo("row " + i);
        }
    }

    @Test
    void twoRunsOfTheSameSqlShareItsTextButKeepTheirOwnResults() throws Exception {
        repo.saveStatements(List.of(Fixtures.select("a:1", "call-1", 1, 3), Fixtures.select("a:2", "call-2", 1, 7)));

        CapturedStatement first = repo.allStatements("call-1", 10).get(0);
        CapturedStatement second = repo.allStatements("call-2", 10).get(0);
        assertThat(first.sql()).isEqualTo(second.sql()).isEqualTo("SELECT id, name FROM users WHERE id = ?");
        assertThat(first.outcome().columns()).extracting("name").containsExactly("id", "name");
        assertThat(first.outcome().rowsRead()).isEqualTo(3);
        assertThat(second.outcome().rowsRead()).isEqualTo(7);
        assertThat(repo.rowCount(first.id(), "RESULT")).isEqualTo(3);
        assertThat(repo.rowCount(second.id(), "RESULT")).isEqualTo(7);
        // one SQL text and one column list, whatever the number of runs
        assertThat(count("SELECT COUNT(*) FROM shared_text")).isEqualTo(2);
    }

    @Test
    void sharedTextGoesWhenTheLastStatementUsingItIsDeleted() throws Exception {
        repo.saveStatements(List.of(Fixtures.select("a:1", "call-1", 1, 3), Fixtures.select("a:2", "call-2", 1, 3)));

        repo.deleteForCalls(List.of("call-1"));
        assertThat(count("SELECT COUNT(*) FROM shared_text")).isEqualTo(2);
        assertThat(repo.allStatements("call-2", 10).get(0).sql()).isNotNull();

        repo.deleteForCalls(List.of("call-2"));
        assertThat(count("SELECT COUNT(*) FROM shared_text")).isZero();
        assertThat(count("SELECT COUNT(*) FROM row_blocks")).isZero();
    }

    @Test
    void aValueIsTracedInsideCompressedRows() {
        repo.saveStatements(List.of(Fixtures.select("a:1", "call-1", 1, 250)));

        List<TraceHit> hits = repo.rowsContaining("call-1", "row 142", 50);
        assertThat(hits).singleElement().satisfies(h -> {
            assertThat(h.seq()).isEqualTo(1);
            assertThat(h.where()).isEqualTo(TraceHit.ROW);
            assertThat(h.index()).isEqualTo(142);
            assertThat(h.column()).isEqualTo("1");
        });
        assertThat(repo.rowsContaining("call-1", "row 9999", 50)).isEmpty();
    }

    @Test
    void theSizeCapCountsCompressedBytes() {
        repo.saveStatements(List.of(Fixtures.select("a:1", "call-1", 1, 5000)));
        long rawRows = 0;
        for (List<TypedValue> row : Fixtures.select("x", "x", 1, 5000).rows()) {
            rawRows += row.toString().length();
        }
        assertThat(repo.totalBytes()).isPositive().isLessThan(rawRows / 3);
    }

    @Test
    void aFileOfAnOlderFormatIsWipedOnceKeepingTheCaptureSettings() throws Exception {
        DbCaptureSettings kept = new DbCaptureSettings(1234, List.of("WALLET"), false, DbCaptureSettings.defaults().thresholds(), List.of(), List.of());
        repo.saveSettings("odeysys", kept);
        repo.close();
        Thread.sleep(50);
        // what an older version left: user_version 0, a statements table with its own sql column, plain JSON rows
        try (var c = DriverManager.getConnection("jdbc:sqlite:" + file()); var st = c.createStatement()) {
            st.execute("PRAGMA user_version = 0");
            st.execute("DROP TABLE statements");
            st.execute("CREATE TABLE statements (id INTEGER PRIMARY KEY, call_id TEXT, sql TEXT NOT NULL)");
            st.execute("INSERT INTO statements (call_id, sql) VALUES ('old-call', 'SELECT 1')");
            st.execute("CREATE TABLE result_rows (statement_id INTEGER, part TEXT, row_index INTEGER, values_json TEXT)");
        }
        open();

        assertThat(repo.allStatements("old-call", 10)).isEmpty();
        assertThat(count("SELECT COUNT(*) FROM sqlite_master WHERE name = 'result_rows'")).isZero();
        assertThat(count("PRAGMA user_version")).isEqualTo(SqliteDbCaptureRepository.FORMAT);
        assertThat(repo.settings("odeysys").rowsPerResult()).isEqualTo(1234);
        assertThat(repo.settings("odeysys").beforeImageTables()).containsExactly("WALLET");

        // and only once: what is captured now survives the next start
        repo.saveStatements(List.of(Fixtures.select("a:1", "call-1", 1, 3)));
        close();
        open();
        assertThat(repo.allStatements("call-1", 10)).hasSize(1);
    }

    @Test
    void aCallThatAskedForCaptureAndNeverHeardFromTheAgentIsSilent() {
        repo.recordCaptureAsked("asked-heard", "odeysys", "db,logs", "2026-10-09T10:00:00Z");
        repo.recordCaptureAsked("asked-silent", "odeysys", "db,logs,redis", "2026-10-09T10:00:00Z");
        repo.recordCaptureAsked("asked-just-now", "odeysys", "db", "2026-10-09T10:05:00Z");
        repo.saveMarkers(List.of(new com.fathy.alfred.backend.dbcapture.domain.model.CallMarker("asked-heard", 0,
                com.fathy.alfred.backend.dbcapture.domain.model.MarkerType.CALL_OPEN, "2026-10-09T10:00:00Z", null, null)));

        assertThat(repo.silentCalls(List.of("asked-heard", "asked-silent", "asked-just-now", "never-asked"), "2026-10-09T10:01:00Z"))
                .containsExactly(java.util.Map.entry("asked-silent", "db,logs,redis"));

        repo.deleteForCalls(List.of("asked-silent"));
        assertThat(repo.silentCalls(List.of("asked-silent"), "2026-10-09T10:01:00Z")).isEmpty();
    }
}
