package com.fathy.alfred.backend.dbcapture.adapter.out.sqlite;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.dbcapture.application.port.in.CallLogLinesUseCase;
import com.fathy.alfred.backend.dbcapture.application.service.DbCaptureQueryService;
import com.fathy.alfred.backend.dbcapture.domain.model.CaughtLogLine;
import com.fathy.alfred.backend.dbcapture.domain.model.LogSearchPage;
import com.fathy.alfred.backend.dbcapture.domain.model.LogSearchQuery;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Search and grouping at real scale (specs/010-mcp-log-investigation, SC-002/plan Performance Goals): 600,000 caught
 * lines over 20,000 calls - a scope of 5,000 calls - each answer in under a second. Lines look like the application's
 * (logger, thread, a context map with varying numbers), 2 % of them errors.
 */
class LogSearchScaleTest {

    private static final int CALLS = 20_000;
    private static final int LINES_PER_CALL = 30;

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
        long t0 = 1_790_000_000_000L;
        List<CaughtLogLine> batch = new ArrayList<>();
        for (int c = 0; c < CALLS; c++) {
            for (int i = 0; i < LINES_PER_CALL; i++) {
                boolean error = (c * LINES_PER_CALL + i) % 50 == 0;
                String message = error
                        ? (c % 3 == 0 ? "No enum constant com.tt.Status.PENDNG" : "Booking " + (100_000 + c) + " not found")
                        : "{context={timeTaken=" + (c * 7 + i) + ", externalService=NDCGal, actionName=Search, step=" + i + "}}";
                batch.add(new CaughtLogLine(0, "call-" + c, i + 1, Instant.ofEpochMilli(t0 + c * 1000L + i).toString(), error ? "ERROR" : "INFO",
                        error ? "com.tt.nc.MainLogger" : "com.tt.nc.DetailLogger", "default task-" + (c % 64), message, null, null, null, false, "odeysys"));
            }
            if (batch.size() >= 6_000) {
                repo.saveLogLines(batch);
                batch = new ArrayList<>();
            }
        }
        repo.saveLogLines(batch);
    }

    @AfterEach
    void close() throws InterruptedException {
        repo.close();
        Thread.sleep(50);
    }

    private static long millisOf(Runnable work) {
        long started = System.nanoTime();
        work.run();
        return (System.nanoTime() - started) / 1_000_000;
    }

    @Test
    void searchAndGroupingOverAScopeOfThousandsOfCallsAnswerInUnderASecond() {
        Set<String> scope = new HashSet<>();
        for (int c = 0; c < 5_000; c++) {
            scope.add("call-" + (c * 4));
        }
        LogSearchPage[] found = new LogSearchPage[1];
        long search = millisOf(() -> found[0] = logs.search(scope, new LogSearchQuery("No enum constant", null, null, null, null, null, null, false, null, 50)));
        assertThat(found[0].total()).isGreaterThan(0);
        assertThat(search).isLessThan(1_000);

        long everywhere = millisOf(() -> found[0] = logs.search(null, new LogSearchQuery("externalService=NDCGal", null, "ERROR", null, null, null, null, false, null, 50)));
        assertThat(found[0].total()).isZero();
        assertThat(everywhere).isLessThan(1_000);

        CallLogLinesUseCase.LogProblemsPage[] problems = new CallLogLinesUseCase.LogProblemsPage[1];
        long grouping = millisOf(() -> problems[0] = logs.problems(scope, false, null, null, 30));
        assertThat(problems[0].groups()).isEqualTo(2); // "Booking <n> not found" and the enum error, whatever the ids
        assertThat(grouping).isLessThan(1_000);
    }
}
