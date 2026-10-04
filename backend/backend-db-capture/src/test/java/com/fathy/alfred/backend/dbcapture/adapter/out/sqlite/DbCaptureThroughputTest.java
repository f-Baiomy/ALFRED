package com.fathy.alfred.backend.dbcapture.adapter.out.sqlite;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.dbcapture.Fixtures;
import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureNotificationPort;
import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureTogglePort;
import com.fathy.alfred.backend.dbcapture.application.service.DbCaptureFlagsListener;
import com.fathy.alfred.backend.dbcapture.application.service.DbCaptureQueryService;
import com.fathy.alfred.backend.dbcapture.application.service.DbCaptureService;
import com.fathy.alfred.backend.dbcapture.domain.model.IncomingStatement;
import com.fathy.alfred.backend.dbcapture.domain.model.IngestBatch;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

/**
 * The numbers docs/db-capture.md quotes (T113): ingest throughput with 50 calls arriving at once, the window's first
 * page of a 500-statement call, scrolling all 50,000 stored rows of one result 100 at a time, and db-capture.db's size
 * per 1,000 calls. Bounds are loose - they catch a regression by an order of magnitude, not machine noise.
 */
class DbCaptureThroughputTest {

    @TempDir
    Path tempDir;

    private SqliteDbCaptureRepository repo;
    private DbCaptureService service;

    @BeforeEach
    void open() throws Exception {
        repo = new SqliteDbCaptureRepository(new ObjectMapper().findAndRegisterModules());
        Field field = SqliteDbCaptureRepository.class.getDeclaredField("dbFile");
        field.setAccessible(true);
        field.set(repo, tempDir.resolve("db-capture.db").toString());
        repo.init();
        service = new DbCaptureService(repo, mock(DbCaptureNotificationPort.class), mock(DbCaptureTogglePort.class),
                List.of(new DbCaptureFlagsListener(repo)), Optional.empty());
    }

    @AfterEach
    void close() throws InterruptedException {
        repo.close();
        Thread.sleep(50);
    }

    private static List<IncomingStatement> call(String callId, int statements, int rows) {
        List<IncomingStatement> out = new ArrayList<>();
        for (int i = 1; i <= statements; i++) {
            out.add(Fixtures.select(callId + ":" + i, callId, i, rows));
        }
        return out;
    }

    @Test
    void ingestAndReadAtRealisticVolume() throws Exception {
        // 1,000 calls of 20 statements (5 rows each), 50 at a time.
        int calls = 1_000;
        ExecutorService pool = Executors.newFixedThreadPool(50);
        long start = System.nanoTime();
        List<Future<?>> futures = new ArrayList<>();
        for (int c = 0; c < calls; c++) {
            String callId = "call-" + c;
            futures.add(pool.submit(() -> service.ingest(new IngestBatch("agent", "wallet-app", call(callId, 20, 5), List.of(), Map.of()))));
        }
        for (Future<?> f : futures) {
            f.get();
        }
        pool.shutdown();
        assertThat(pool.awaitTermination(1, TimeUnit.MINUTES)).isTrue();
        double seconds = (System.nanoTime() - start) / 1e9;
        double perSecond = calls * 20 / seconds;
        long bytes = Files.size(tempDir.resolve("db-capture.db"));

        // A 500-statement call: the window's first page, then one result's 50,000 rows scrolled 100 at a time.
        service.ingest(new IngestBatch("agent", "wallet-app", call("big", 500, 2), List.of(), Map.of()));
        service.ingest(new IngestBatch("agent", "wallet-app", List.of(Fixtures.select("huge:1", "huge", 1, 50_000)), List.of(), Map.of()));
        DbCaptureQueryService query = new DbCaptureQueryService(repo, service);
        long openStart = System.nanoTime();
        var page = query.statements("big", 0, 500);
        double openMs = (System.nanoTime() - openStart) / 1e6;
        long hugeId = repo.allStatements("huge", 1).get(0).id();
        long scrollStart = System.nanoTime();
        long seen = 0;
        for (int offset = 0; offset < 50_000; offset += 100) {
            seen += query.rows(hugeId, "RESULT", offset, 100).orElseThrow().rows().size();
        }
        double scrollMs = (System.nanoTime() - scrollStart) / 1e6;

        System.out.printf("[measure] ingest: %d calls x 20 statements, 50 at once: %.0f statements/s (%.1f s)%n", calls, perSecond, seconds);
        System.out.printf("[measure] db-capture.db after 1,000 calls (20 statements, 5 rows each): %.1f MB%n", bytes / 1024.0 / 1024.0);
        System.out.printf("[measure] window first page of a 500-statement call: %.1f ms%n", openMs);
        System.out.printf("[measure] 50,000 stored rows read 100 at a time: %.0f ms total, %.2f ms per page%n", scrollMs, scrollMs / 500);

        assertThat(page.statements()).hasSize(500);
        assertThat(seen).isEqualTo(50_000);
        assertThat(perSecond).isGreaterThan(500);
        assertThat(openMs).isLessThan(2_000);
        assertThat(scrollMs / 500).isLessThan(100);
    }
}
