package com.fathy.alfred.backend.logs.application.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.logs.adapter.out.input.FileLineSource;
import com.fathy.alfred.backend.logs.adapter.out.input.LocalLogFiles;
import com.fathy.alfred.backend.logs.adapter.out.rawfile.OffsetRawLineReader;
import com.fathy.alfred.backend.logs.adapter.out.sqlite.SqliteLogCommentStoreAdapter;
import com.fathy.alfred.backend.logs.adapter.out.sqlite.SqliteLogInputStoreAdapter;
import com.fathy.alfred.backend.logs.adapter.out.sqlite.SqliteLogLineStoreAdapter;
import com.fathy.alfred.backend.logs.adapter.out.sqlite.SqliteLogSourceStoreAdapter;
import com.fathy.alfred.backend.logs.adapter.out.sqlite.SqliteLogsRepository;
import com.fathy.alfred.backend.logs.application.port.out.LogNotificationPort;
import com.fathy.alfred.backend.logs.domain.model.GroupLevel;
import com.fathy.alfred.backend.logs.domain.model.GroupSort;
import com.fathy.alfred.backend.logs.domain.model.IngestProgress;
import com.fathy.alfred.backend.logs.domain.model.InputKind;
import com.fathy.alfred.backend.logs.domain.model.InputStatus;
import com.fathy.alfred.backend.logs.domain.model.LogInput;
import com.fathy.alfred.backend.logs.domain.model.LogQuery;
import com.fathy.alfred.backend.logs.domain.model.LogStructure;
import com.fathy.alfred.backend.logs.domain.model.PrivacyMode;
import com.fathy.alfred.backend.logs.domain.model.RawMode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.util.ReflectionTestUtils;

import java.io.BufferedWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Random;

/**
 * Throughput measurement for docs/logs.md (T094), not a regular test: run with
 * {@code -Dlogs.perf.lines=200000}. Prints lines/s and query latencies on the container's own disk.
 */
@EnabledIfSystemProperty(named = "logs.perf.lines", matches = "\\d+")
class LogsIngestPerformanceTest {

    @TempDir
    Path dir;

    @Test
    void measure() throws Exception {
        int n = Integer.parseInt(System.getProperty("logs.perf.lines"));
        Path drop = Files.createDirectories(dir.resolve("drop"));
        Path file = drop.resolve("perf.ndjson");
        Random rnd = new Random(11);
        String[] sup = {"TravelportNdc", "FlyAdealUAE", "Sabre", "Amadeus"};
        try (BufferedWriter w = Files.newBufferedWriter(file, StandardCharsets.UTF_8)) {
            for (int i = 0; i < n; i++) {
                int s = i / 15;
                String level = rnd.nextInt(10) == 0 ? "ERROR" : "INFO";
                w.write("{\"_id\":\"" + Long.toHexString(rnd.nextLong()) + "\",\"_source\":{\"attributes\":{\"log.level\":\"" + level
                        + "\",\"message\":{\"methodName\":\"performOperation\",\"message\":\"End external system call " + (i % 7)
                        + "\",\"sessionId\":\"S-" + s + "\",\"inboundCallId\":\"IC-" + (i / 5) + "\",\"externalCallId\":\"EX-" + i
                        + "\",\"context\":{\"externalService\":\"" + sup[i % 4] + "\",\"statusCode\":" + (level.equals("ERROR") ? 504 : 200)
                        + ",\"timeTaken\":" + rnd.nextInt(30000) + ",\"request\":\"LoginDTO(email=agent" + (i % 97)
                        + "@travel.ae, password=null)\"}},\"timestamp\":\"" + java.time.Instant.ofEpochMilli(1_790_000_000_000L + i * 250L)
                        + "\"},\"fields\":{\"VM_name\":[\"portal-" + (i % 2 + 24) + "\"]}}}\n");
            }
        }
        ObjectMapper mapper = new ObjectMapper();
        SqliteLogsRepository repo = new SqliteLogsRepository();
        ReflectionTestUtils.setField(repo, "dbFile", dir.resolve("logs.db").toString());
        ReflectionTestUtils.invokeMethod(repo, "init");
        var lines = new SqliteLogLineStoreAdapter(repo);
        var sources = new SqliteLogSourceStoreAdapter(repo, mapper);
        var inputs = new SqliteLogInputStoreAdapter(repo);
        var comments = new SqliteLogCommentStoreAdapter(repo, mapper);
        LogNotificationPort quiet = new LogNotificationPort() {
            public void linesAdded(String s, long c, long t) { }
            public void progress(IngestProgress p) { }
            public void structureChanged(String s, String r) { }
            public void sourcesChanged() { }
            public void commentChanged(String s, String l) { }
        };
        var tracker = new LogsChangeTracker();
        var ingest = new LogIngestService(sources, inputs, lines, new FileLineSource(), quiet, mapper, tracker);
        ReflectionTestUtils.setField(ingest, "dbFile", dir.resolve("logs.db").toString());
        ReflectionTestUtils.setField(ingest, "minFreeBytes", 0L);
        var files = new LocalLogFiles();
        ReflectionTestUtils.setField(files, "rootDir", drop.toString());
        ReflectionTestUtils.setField(files, "uploadDir", dir.resolve("up").toString());
        var svc = new LogSourcesService(sources, inputs, lines, comments, files, quiet, ingest,
                new StructureRebuildService(sources, lines, quiet, ingest), mapper);
        var query = new LogQueryService(sources, inputs, lines, comments, new OffsetRawLineReader(), quiet, tracker);

        LogStructure s = svc.preview(null, "perf.ndjson").structure();
        s = new LogStructure(s.id(), s.fields(), List.of(new GroupLevel("sessionId", GroupSort.TIME_ASC),
                new GroupLevel("inboundCallId", GroupSort.TIME_ASC), new GroupLevel("externalCallId", GroupSort.TIME_ASC)),
                s.template(), List.of(), s.defaultDataView(), "UTC");
        if (Boolean.getBoolean("logs.perf.noindex")) {
            s = s.withFields(s.fields().stream().map(f -> new com.fathy.alfred.backend.logs.domain.model.FieldDef(f.index(), f.path(), f.label(),
                    f.type(), f.typeSource(), f.format(), f.matchRate(), f.invalidCount(), f.suggestBoolean(),
                    f.searchMode() == com.fathy.alfred.backend.logs.domain.model.SearchMode.EXACT ? com.fathy.alfred.backend.logs.domain.model.SearchMode.NONE : f.searchMode(),
                    f.role(), f.sensitive(), f.duplicateOf(), f.firstSeenLine(), f.sample())).toList());
            s = new LogStructure(s.id(), s.fields(), List.of(), s.template(), List.of(), s.defaultDataView(), "UTC");
        }
        String id = svc.create("perf", RawMode.COPY, PrivacyMode.SHOW, s).source().id();
        long t0 = System.nanoTime();
        LogInput in = svc.add(id, InputKind.SERVER_FILE, "perf.ndjson", null, true, true);
        while (inputs.get(in.id()).orElseThrow().status() != InputStatus.DONE) {
            Thread.sleep(100);
        }
        double secs = (System.nanoTime() - t0) / 1e9;
        System.out.printf("PERF ingest %d lines (%.0f MB) in %.1f s = %.0f lines/s, db %.0f MB%n", n, Files.size(file) / 1e6, secs, n / secs,
                Files.size(dir.resolve("logs.db")) / 1e6);
        time("exact level=ERROR", () -> query.lines(id, q(new LogQuery.Pill(LogQuery.Op.EQ, "level", "ERROR", null, null, null))));
        time("text fragment", () -> query.lines(id, q(new LogQuery.Pill(LogQuery.Op.TEXT, null, "agent7", null, null, null))));
        time("range timeTaken>25000", () -> query.lines(id, q(new LogQuery.Pill(LogQuery.Op.GT, "timeTaken", "25000", null, null, null))));
        time("histogram", () -> query.histogram(id, q(), 60));
        time("group roots", () -> query.groups(id, q(), "", 0, 100));
        time("field values", () -> query.fieldValues(id, q()));
        time("minimap", () -> query.minimap(id, q(), List.of()));
        ReflectionTestUtils.invokeMethod(ingest, "shutdown");
        ReflectionTestUtils.invokeMethod(repo, "close");
    }

    private static LogQuery q(LogQuery.Pill... pills) {
        return new LogQuery(List.of(pills), null, null, null, null, 0);
    }

    private static void time(String name, java.util.function.Supplier<?> call) {
        call.get();
        long t = System.nanoTime();
        call.get();
        System.out.printf("PERF %s: %.0f ms%n", name, (System.nanoTime() - t) / 1e6);
    }
}
