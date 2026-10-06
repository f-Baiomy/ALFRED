package com.fathy.alfred.backend.dbcapture.adapter.out.sqlite;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.dbcapture.application.port.in.CallLogLinesUseCase;
import com.fathy.alfred.backend.dbcapture.application.service.DbCaptureQueryService;
import com.fathy.alfred.backend.dbcapture.domain.LogFingerprint;
import com.fathy.alfred.backend.dbcapture.domain.model.CallMarker;
import com.fathy.alfred.backend.dbcapture.domain.model.CaughtLogLine;
import com.fathy.alfred.backend.dbcapture.domain.model.LogProblem;
import com.fathy.alfred.backend.dbcapture.domain.model.LogSearchPage;
import com.fathy.alfred.backend.dbcapture.domain.model.LogSearchQuery;
import com.fathy.alfred.backend.dbcapture.domain.model.MarkerType;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.JdbcTemplate;

import java.lang.reflect.Field;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Searching and grouping caught lines across calls (specs/010-mcp-log-investigation): the trigram index, its upkeep on
 * every delete, fingerprints at ingest and for lines stored before them, scopes, and the pattern time bound.
 */
class SqliteLogSearchTest {

    @TempDir
    Path tempDir;

    private SqliteDbCaptureRepository repo;
    private CallLogLinesUseCase logs;

    @BeforeEach
    void open() throws Exception {
        repo = new SqliteDbCaptureRepository(new ObjectMapper().findAndRegisterModules());
        Field field = SqliteDbCaptureRepository.class.getDeclaredField("dbFile");
        field.setAccessible(true);
        field.set(repo, tempDir.resolve("db-capture.db").toString());
        repo.init();
        logs = new DbCaptureQueryService(repo, null);
    }

    @AfterEach
    void close() throws InterruptedException {
        repo.close();
        Thread.sleep(50);
    }

    private JdbcTemplate jdbc() throws Exception {
        Field field = SqliteDbCaptureRepository.class.getDeclaredField("jdbcTemplate");
        field.setAccessible(true);
        return (JdbcTemplate) field.get(repo);
    }

    private static CaughtLogLine line(String callId, int seq, String level, String logger, String thread, String message, String exType) {
        return new CaughtLogLine(0, callId, seq, Instant.ofEpochMilli(1_790_000_000_000L + seq * 1000L).toString(), level, logger, thread, message,
                exType, exType == null ? null : "bad", exType == null ? null : exType + ": bad\n\tat com.tt.Svc.run(Svc.java:42)", false, "odeysys");
    }

    private static LogSearchQuery text(String text) {
        return new LogSearchQuery(text, null, null, null, null, null, null, false, null, 50);
    }

    @Test
    void textSearchFindsMessagesLoggersThreadsAndExceptionsCaseInsensitivelyAndExactlyCounted() {
        repo.saveLogLines(List.of(
                line("c1", 1, "ERROR", "com.tt.MainLogger", "default task-4", "No enum constant com.tt.Status.PENDNG", "java.lang.IllegalArgumentException"),
                line("c2", 2, "INFO", "com.tt.DetailLogger", "default task-9", "search started for 100% of \"fares\"", null),
                line("c3", 3, "WARN", "com.tt.Pricing", "scheduler-1", "fare 12 exceeds limit", null),
                line(null, 4, "ERROR", "job", "sched-2", "No enum constant outside", null)));

        assertThat(logs.search(null, text("no ENUM constant")).lines()).extracting(CaughtLogLine::callId).containsExactly("c1");
        assertThat(logs.search(null, new LogSearchQuery("no enum constant", null, null, null, null, null, null, true, null, 50)).total()).isEqualTo(2);
        assertThat(logs.search(null, text("DetailLogger")).lines()).extracting(CaughtLogLine::callId).containsExactly("c2");
        assertThat(logs.search(null, text("task-9")).lines()).extracting(CaughtLogLine::callId).containsExactly("c2");
        assertThat(logs.search(null, text("IllegalArgument")).lines()).extracting(CaughtLogLine::callId).containsExactly("c1");
        assertThat(logs.search(null, text("100% of \"fares\"")).lines()).extracting(CaughtLogLine::callId).containsExactly("c2");
        assertThat(logs.search(null, text("12")).lines()).extracting(CaughtLogLine::callId).containsExactly("c3"); // under 3 characters: LIKE
        assertThat(logs.search(null, new LogSearchQuery(null, null, "WARN", null, null, null, null, false, null, 50)).lines())
                .extracting(CaughtLogLine::callId).containsExactly("c3", "c1");
        assertThat(logs.search(null, new LogSearchQuery(null, null, null, null, "IllegalArgument", null, null, false, null, 50)).total()).isEqualTo(1);
        assertThat(logs.search(Set.of("c2", "c3"), text("enum")).total()).isZero();
        assertThatThrownBy(() -> logs.search(null, new LogSearchQuery(null, null, "LOUD", null, null, null, null, false, null, 50)))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void pagesNewestFirstWithACursorAndTheIndexFollowsEveryDelete() {
        List<CaughtLogLine> many = new ArrayList<>();
        for (int i = 0; i < 120; i++) {
            many.add(line("c" + (i % 3), i, "ERROR", "L", "t", "timeout talking to supplier " + i, null));
        }
        repo.saveLogLines(many);

        LogSearchPage first = logs.search(null, new LogSearchQuery("timeout talking", null, null, null, null, null, null, false, null, 50));
        assertThat(first.total()).isEqualTo(120);
        assertThat(first.lines()).hasSize(50);
        LogSearchPage second = logs.search(null, new LogSearchQuery("timeout talking", null, null, null, null, null, null, false, first.nextBeforeId(), 50));
        assertThat(second.lines().get(0).id()).isLessThan(first.lines().get(49).id());

        repo.deleteForCalls(List.of("c0"));
        repo.deleteLogLines("c2");
        assertThat(logs.search(null, text("timeout talking")).total()).isEqualTo(40); // c1's lines remain; the index lost the others
    }

    @Test
    void fingerprintsAreSetAtIngestAndBackfilledForOlderLines() throws Exception {
        repo.saveLogLines(List.of(line("c1", 1, "ERROR", "L", "t", "Booking 12345 not found", null)));
        String fp = jdbc().queryForObject("SELECT fingerprint FROM call_log_lines", String.class);
        assertThat(fp).isEqualTo(LogFingerprint.of("L", null, "Booking 999 not found"));

        jdbc().update("UPDATE call_log_lines SET fingerprint = NULL");
        jdbc().update("DELETE FROM call_log_text");
        repo.backfillLogs(true, 10);
        assertThat(jdbc().queryForObject("SELECT fingerprint FROM call_log_lines", String.class)).isEqualTo(fp);
        assertThat(logs.search(null, text("12345")).total()).isEqualTo(1);
    }

    @Test
    void repeatedErrorsWithDifferentIdsAreOneProblemAndDifferentErrorsNeverMerge() {
        List<CaughtLogLine> lines = new ArrayList<>();
        for (int i = 0; i < 40; i++) {
            lines.add(line("call-" + i, 1, "ERROR", "BookingService", "t", "Booking " + (1000 + i) + " not found", null));
        }
        lines.add(line("call-a", 2, "ERROR", "Net", "t", "Connection refused to 10.0.0.1:80", "java.net.ConnectException"));
        lines.add(line("call-b", 2, "ERROR", "Net", "t", "Connection refused to 10.0.0.2:80", "java.net.ConnectException"));
        lines.add(line("call-b", 3, "WARN", "Pricing", "t", "fare rounding", null));
        lines.add(line("call-b", 4, "INFO", "Pricing", "t", "fare ok", null));
        repo.saveLogLines(lines);

        CallLogLinesUseCase.LogProblemsPage errors = logs.problems(null, false, null, null, 10);
        assertThat(errors.groups()).isEqualTo(2);
        assertThat(errors.problems()).extracting(LogProblem::lines).containsExactly(40L, 2L);
        assertThat(errors.problems().get(0).calls()).isEqualTo(40);
        assertThat(errors.problems().get(0).callIds()).hasSize(40);
        assertThat(errors.problems().get(1).sample().exceptionType()).isEqualTo("java.net.ConnectException");
        assertThat(logs.problems(null, true, null, null, 10).groups()).isEqualTo(3);
        assertThat(logs.problems(Set.of("call-a"), false, null, null, 10).problems()).extracting(LogProblem::lines).containsExactly(1L);

        String booking = errors.problems().get(0).fingerprint();
        assertThat(logs.problemCalls(null, booking, 0, 10)).hasSize(10);
        assertThat(logs.problemCalls(null, booking, 35, 10)).hasSize(5);
        assertThatThrownBy(() -> logs.problemCalls(null, "nope", 0, 10)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void aPatternSearchMatchesAndACatastrophicPatternIsCutShortInTime() {
        repo.saveLogLines(List.of(
                line("c1", 1, "ERROR", "L", "t", "order ORD-20391 failed", null),
                line("c2", 2, "ERROR", "L", "t", "order ORD-7 failed", null),
                line("c3", 3, "ERROR", "L", "t", "order created", null)));
        LogSearchPage found = logs.search(null, new LogSearchQuery(null, "order ORD-\\d{5} failed", null, null, null, null, null, false, null, 50));
        assertThat(found.lines()).extracting(CaughtLogLine::callId).containsExactly("c1");
        assertThat(found.cutShort()).isNull();

        List<CaughtLogLine> evil = new ArrayList<>();
        for (int i = 0; i < 20; i++) {
            evil.add(line("e" + i, i, "ERROR", "L", "t", "a".repeat(5_000) + "b", null));
        }
        repo.saveLogLines(evil);
        long started = System.nanoTime();
        LogSearchPage cut = logs.search(null, new LogSearchQuery(null, "(a+)+$", null, null, null, null, null, false, null, 50));
        assertThat((System.nanoTime() - started) / 1_000_000).isLessThan(3_000);
        assertThat(cut.cutShort()).isNotNull();
        assertThat(cut.cutShort().reason()).isEqualTo("TIME");
        assertThatThrownBy(() -> logs.search(null, new LogSearchQuery(null, "(unclosed", null, null, null, null, null, false, null, 50)))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void outsideLinesInAWindowAtALevelAndTheLevelACallWasCaughtAt() {
        repo.saveLogLines(List.of(line(null, 1, "ERROR", "job", "sched", "early", null), line(null, 5, "INFO", "job", "sched", "info", null),
                line(null, 9, "ERROR", "job", "sched", "late", null)));
        long t0 = 1_790_000_000_000L;
        assertThat(logs.outside("odeysys", null, 0, 50, t0 + 3_000, t0 + 10_000, "ERROR")).extracting(CaughtLogLine::message).containsExactly("late");

        repo.saveMarkers(List.of(new CallMarker("lv", 0, MarkerType.CALL_OPEN, "2026-10-06T10:00:00Z", null, null, "t", true, "WARN")));
        assertThat(logs.capturedLevel("lv")).contains("WARN");
        assertThat(logs.capturedLevel("none")).isEmpty();
    }
}
