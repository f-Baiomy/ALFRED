package com.fathy.alfred.backend.logs.application.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.logs.adapter.in.watch.WatchServiceEvents;
import com.fathy.alfred.backend.logs.adapter.out.input.FileLineSource;
import com.fathy.alfred.backend.logs.adapter.out.input.LocalLogFiles;
import com.fathy.alfred.backend.logs.adapter.out.input.LocalWatchFolders;
import com.fathy.alfred.backend.logs.adapter.out.rawfile.OffsetRawLineReader;
import com.fathy.alfred.backend.logs.adapter.out.sqlite.SqliteLogCommentStoreAdapter;
import com.fathy.alfred.backend.logs.adapter.out.sqlite.SqliteLogInputStoreAdapter;
import com.fathy.alfred.backend.logs.adapter.out.sqlite.SqliteLogLineStoreAdapter;
import com.fathy.alfred.backend.logs.adapter.out.sqlite.SqliteLogSessionStoreAdapter;
import com.fathy.alfred.backend.logs.adapter.out.sqlite.SqliteLogSourceStoreAdapter;
import com.fathy.alfred.backend.logs.adapter.out.sqlite.SqliteLogsRepository;
import com.fathy.alfred.backend.logs.application.port.out.LogNotificationPort;
import com.fathy.alfred.backend.logs.application.port.out.WatchFoldersPort;
import com.fathy.alfred.backend.logs.domain.model.IngestProgress;
import com.fathy.alfred.backend.logs.domain.model.InputKind;
import com.fathy.alfred.backend.logs.domain.model.InputStatus;
import com.fathy.alfred.backend.logs.domain.model.LogInput;
import com.fathy.alfred.backend.logs.domain.model.LogQuery;
import com.fathy.alfred.backend.logs.domain.model.LogSession;
import com.fathy.alfred.backend.logs.domain.model.PrivacyMode;
import com.fathy.alfred.backend.logs.domain.model.RawMode;
import com.fathy.alfred.backend.logs.domain.model.WatchOptions;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.util.ReflectionTestUtils;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Supplier;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Watched folders end to end on real files, with the kernel's change notifications (the test runs on
 * Linux in CI/Docker): start with the last N lines, follow appends without any timer, pick up a new file,
 * survive a rename rotation without reading anything twice; then record sessions on the live log.
 */
class LogsWatchAndSessionsTest {

    @TempDir
    Path dir;

    private SqliteLogsRepository repository;
    private SqliteLogInputStoreAdapter inputStore;
    private LogIngestService ingest;
    private LogSourcesService sources;
    private LogQueryService query;
    private LogSessionsService sessions;
    private LogWatchService watch;
    private LocalWatchFolders folders;
    private WatchServiceEvents events;
    private Path app;
    private int n;

    private static String line(int i, String sid, String level) {
        return "{\"timestamp\":\"2026-10-04T10:00:" + String.format("%02d", i % 60) + "Z\",\"level\":\"" + level
                + "\",\"message\":\"line " + i + "\",\"sessionId\":\"" + sid + "\"}";
    }

    private void append(Path file, int count, String sid) throws Exception {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < count; i++) {
            b.append(line(n++, sid, n % 5 == 0 ? "ERROR" : "INFO")).append('\n');
        }
        Files.writeString(file, b.toString(), StandardCharsets.UTF_8, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
    }

    @BeforeEach
    void setUp() throws Exception {
        ObjectMapper mapper = new ObjectMapper();
        repository = new SqliteLogsRepository();
        ReflectionTestUtils.setField(repository, "dbFile", dir.resolve("logs.db").toString());
        ReflectionTestUtils.invokeMethod(repository, "init");
        var lineStore = new SqliteLogLineStoreAdapter(repository);
        var sourceStore = new SqliteLogSourceStoreAdapter(repository, mapper);
        inputStore = new SqliteLogInputStoreAdapter(repository);
        var commentStore = new SqliteLogCommentStoreAdapter(repository, mapper);
        var sessionStore = new SqliteLogSessionStoreAdapter(repository, mapper);
        LogNotificationPort quiet = new LogNotificationPort() {
            public void linesAdded(String s, long c, long t) { }
            public void progress(IngestProgress p) { }
            public void structureChanged(String s, String r) { }
            public void sourcesChanged() { }
            public void commentChanged(String s, String l) { }
        };
        var tracker = new LogsChangeTracker();
        var signals = new FileChangeSignals(); // shared: the watch service signals, the readers wait
        ingest = new LogIngestService(sourceStore, inputStore, lineStore, new FileLineSource(), quiet, mapper, tracker, signals);
        ReflectionTestUtils.setField(ingest, "dbFile", dir.resolve("logs.db").toString());
        ReflectionTestUtils.setField(ingest, "minFreeBytes", 0L);
        // The ONLY timer is for single followed files under /logs; watched files must not depend on it.
        ReflectionTestUtils.setField(ingest, "followStatMs", 3_600_000L);

        Path watchRoot = Files.createDirectories(dir.resolve("watch"));
        app = Files.createDirectories(watchRoot.resolve("app"));
        folders = new LocalWatchFolders();
        ReflectionTestUtils.setField(folders, "watchDirs", "app:/opt/app/log, bad name:/x");
        ReflectionTestUtils.setField(folders, "watchRoot", watchRoot.toString());
        watch = new LogWatchService(folders, inputStore, ingest, signals, quiet, mapper);
        ReflectionTestUtils.setField(watch, "mode", "events");

        var rebuild = new StructureRebuildService(sourceStore, lineStore, quiet, ingest);
        LocalLogFiles files = new LocalLogFiles();
        ReflectionTestUtils.setField(files, "rootDir", dir.resolve("drop").toString());
        ReflectionTestUtils.setField(files, "uploadDir", dir.resolve("uploads").toString());
        sources = new LogSourcesService(sourceStore, inputStore, lineStore, commentStore, files, quiet, ingest, rebuild, mapper, watch,
                sessionStore);
        query = new LogQueryService(sourceStore, inputStore, lineStore, commentStore, new OffsetRawLineReader(), quiet, tracker);
        sessions = new LogSessionsService(sourceStore, sessionStore, lineStore, quiet);

        // Existing files: the live file with 10 lines, an archive (rotated copy) with 10 older lines, and noise.
        append(app.resolve("detail.log.1"), 10, "OLD");
        append(app.resolve("detail.log"), 10, "S1");
        Files.writeString(app.resolve("server.out"), "not a log line\n");
    }

    @AfterEach
    void tearDown() {
        if (events != null) {
            ReflectionTestUtils.invokeMethod(events, "stop");
        }
        ReflectionTestUtils.invokeMethod(ingest, "shutdown");
        ReflectionTestUtils.invokeMethod(repository, "close");
    }

    private static void await(Supplier<Boolean> condition) throws InterruptedException {
        for (int i = 0; i < 200 && !condition.get(); i++) {
            Thread.sleep(50);
        }
        assertThat(condition.get()).isTrue();
    }

    private String createSource() {
        var preview = sources.preview(List.of(line(0, "S1", "INFO"), line(1, "S2", "WARN")), null);
        return sources.create("app", RawMode.COPY, PrivacyMode.SHOW, preview.structure()).source().id();
    }

    private long total(String id) {
        return query.lines(id, new LogQuery(List.of(), null, null, null, null, 0)).total();
    }

    @Test
    void foldersAreListedFromTheSettingAndLastLinesCountsCompleteLinesOnly() throws Exception {
        assertThat(watch.folders().folders()).extracting(WatchFoldersPort.Folder::name).containsExactly("app");
        assertThat(watch.files("app", "detail*.log", false)).extracting(f -> f.relative() + (f.archive() ? " (archive)" : ""))
                .containsExactly("detail.log", "detail.log.1 (archive)");

        Path f = app.resolve("partial.log");
        Files.writeString(f, "a\nbb\nccc\nhalf-written");
        assertThat(folders.lastLines(f.toString(), 2)).isEqualTo(new WatchFoldersPort.LastLines(2, 2)); // "bb", "ccc"
        assertThat(folders.lastLines(f.toString(), 9)).isEqualTo(new WatchFoldersPort.LastLines(0, 3));
    }

    @Test
    void startsWithTheLastLinesThenFollowsOnNotificationsNewFilesAndRotationWithoutRereading() throws Exception {
        events = new WatchServiceEvents(watch, folders);
        events.start(); // the kernel's notifications - the only thing that wakes a waiting reader

        String id = createSource();
        LogInput w = sources.addWatch(id, new WatchOptions("app", "detail*.log", false, WatchOptions.Start.LAST, 15, false));
        assertThat(w.kind()).isEqualTo(InputKind.WATCH);
        // Last 15 across files, newest first: all 10 of detail.log + the last 5 of the archive.
        await(() -> total(id) == 15);
        assertThat(inputStore.byParent(w.id())).extracting(LogInput::fileName).containsExactlyInAnyOrder("detail.log", "detail.log.1");

        // Appends are seen through notifications alone (the polling interval is an hour in this test).
        append(app.resolve("detail.log"), 3, "S1");
        await(() -> total(id) == 18);

        // A new live file is picked up and read from its first line.
        append(app.resolve("detail-2.log"), 4, "S2");
        await(() -> total(id) == 22);

        // Rotation: detail.log is renamed to an archive and a new detail.log starts. The renamed lines
        // were already read and are not read again; the new file's lines are.
        Files.move(app.resolve("detail.log"), app.resolve("detail.log.2"));
        append(app.resolve("detail.log"), 2, "S1");
        await(() -> total(id) == 24);
        Thread.sleep(500);
        assertThat(total(id)).isEqualTo(24);
        assertThat(inputStore.get(w.id()).orElseThrow().status()).isEqualTo(InputStatus.FOLLOWING);
    }

    @Test
    void onlyNewLinesSkipsTheOldOnesAndPausingStopsTheFolder() throws Exception {
        events = new WatchServiceEvents(watch, folders);
        events.start();
        String id = createSource();
        LogInput w = sources.addWatch(id, new WatchOptions("app", "detail*.log", false, WatchOptions.Start.NEW, 0, false));
        Thread.sleep(300);
        assertThat(total(id)).isZero();
        append(app.resolve("detail.log"), 2, "S1");
        await(() -> total(id) == 2);

        sources.pause(id, w.id());
        append(app.resolve("detail.log"), 2, "S1");
        Thread.sleep(500);
        assertThat(total(id)).isEqualTo(2);
        sources.resume(id, w.id());
        await(() -> total(id) == 4); // resumed from its saved position: nothing lost
    }

    @Test
    void sessionsRecordATimeWindowWithAFilterOrOneIdAndKeepTheirLines() throws Exception {
        events = new WatchServiceEvents(watch, folders);
        events.start();
        String id = createSource();
        sources.addWatch(id, new WatchOptions("app", "detail.log", false, WatchOptions.Start.NEW, 0, false));
        Thread.sleep(200);

        var window = sessions.start(id, "Booking fails", LogSession.Kind.WINDOW, List.of(), null, null);
        var onlyS7 = sessions.start(id, "Agent S7", LogSession.Kind.ID, null, "sessionId", "S7");
        append(app.resolve("detail.log"), 4, "S7");
        append(app.resolve("detail.log"), 6, "S8");
        await(() -> total(id) == 10);
        sessions.mark(id, window.session().id(), "clicked Book");
        assertThat(sessions.session(id, window.session().id()).session().lineCount()).isEqualTo(10); // live count while recording

        var w = sessions.stop(id, window.session().id());
        var s7 = sessions.stop(id, onlyS7.session().id());
        assertThat(w.session().lineCount()).isEqualTo(10);
        assertThat(w.session().markers()).extracting(LogSession.Marker::text).containsExactly("clicked Book");
        assertThat(s7.session().lineCount()).isEqualTo(4);

        // Lines after the stop are not part of it; opening a session is an ordinary query with its pills.
        append(app.resolve("detail.log"), 3, "S7");
        await(() -> total(id) == 13);
        assertThat(query.lines(id, new LogQuery(s7.pills(), null, null, null, null, 0)).total()).isEqualTo(4);
        assertThat(query.lines(id, new LogQuery(new ArrayList<>(w.pills()), null, null, null, null, 0)).lines())
                .allMatch(l -> l.pinned()); // kept forever
        assertThat(sessions.sessions(id)).hasSize(2);
    }
}
