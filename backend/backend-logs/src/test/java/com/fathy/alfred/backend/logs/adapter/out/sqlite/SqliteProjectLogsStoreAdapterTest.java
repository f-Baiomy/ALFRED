package com.fathy.alfred.backend.logs.adapter.out.sqlite;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.logs.domain.model.KeptLogLine;
import com.fathy.alfred.backend.logs.domain.model.ProjectLogSettings;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.util.ReflectionTestUtils;

import java.nio.file.Path;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class SqliteProjectLogsStoreAdapterTest {

    @TempDir
    Path dir;

    private SqliteLogsRepository repository;
    private SqliteProjectLogsStoreAdapter store;

    @BeforeEach
    void setUp() {
        repository = new SqliteLogsRepository();
        ReflectionTestUtils.setField(repository, "dbFile", dir.resolve("logs.db").toString());
        ReflectionTestUtils.invokeMethod(repository, "init");
        store = new SqliteProjectLogsStoreAdapter(repository, new ObjectMapper());
    }

    @AfterEach
    void tearDown() {
        ReflectionTestUtils.invokeMethod(repository, "close");
    }

    private static KeptLogLine line(String callId, String lineId, long at, KeptLogLine.Origin origin) {
        return new KeptLogLine(callId, "s1", "wildfly", lineId, at, "INFO", "default task-4", "DetailLogger", "msg " + lineId,
                "THREAD_TIME", "{\"m\":\"" + lineId + "\"}", origin);
    }

    @Test
    void settingsRoundTripAndReplace() {
        assertThat(store.settings("odeysys")).isEmpty();
        store.saveSettings(new ProjectLogSettings("odeysys", List.of("s1", "s2"), "process.thread.name", null, null, 200));
        store.saveSettings(new ProjectLogSettings("odeysys", List.of("s1"), "process.thread.name", "timestamp", "mdc.alfred.call", 500));
        ProjectLogSettings read = store.settings("odeysys").orElseThrow();
        assertThat(read.sourceIds()).containsExactly("s1");
        assertThat(read.timeField()).isEqualTo("timestamp");
        assertThat(read.clockSkewMs()).isEqualTo(500);
    }

    @Test
    void keptLinesComeBackInTimeOrder_replaceByLine_andAreRemovedByCallAndOrigin() {
        store.keep(List.of(line("c1", "i:2", 2_000, KeptLogLine.Origin.CYCLE), line("c1", "i:1", 1_000, KeptLogLine.Origin.CYCLE),
                line("c2", "i:9", 1_000, KeptLogLine.Origin.IMPORT)));
        store.keep(List.of(line("c1", "i:2", 2_000, KeptLogLine.Origin.CYCLE))); // same line again: one row

        assertThat(store.kept("c1", 100)).extracting(KeptLogLine::lineId).containsExactly("i:1", "i:2");
        assertThat(store.callsWithKept(KeptLogLine.Origin.CYCLE, 10)).containsExactly("c1");

        assertThat(store.removeKept(List.of("c1", "c2"), KeptLogLine.Origin.CYCLE)).isEqualTo(2);
        assertThat(store.kept("c2", 100)).hasSize(1); // an imported call's copies stay
        assertThat(store.removeKept(List.of("c2"), null)).isEqualTo(1);
    }
}
