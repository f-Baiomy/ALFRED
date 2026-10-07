package com.fathy.alfred.backend.server.adapter.out.history;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.server.domain.model.HistoryEntry;
import com.fathy.alfred.backend.server.domain.model.PendingRestart;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class EnvHistoryFileAdapterTest {

    @TempDir
    Path data;

    private final ObjectMapper mapper = new ObjectMapper();

    private EnvHistoryFileAdapter adapter() {
        return new EnvHistoryFileAdapter(data, mapper, Clock.systemUTC());
    }

    @Test
    void entriesAreKeptNewestFirstWithTheContentBeforeAndAfter() {
        EnvHistoryFileAdapter history = adapter();
        long first = history.append(HistoryEntry.HistorySource.INSTALL, "first start", List.of(), "", "A=1\n");
        long second = history.append(HistoryEntry.HistorySource.UI, "192.168.1.23",
                List.of(new HistoryEntry.Change("A", "1", "2")), "A=1\n", "A=2\n");

        assertThat(second).isEqualTo(first + 1);
        assertThat(adapter().recent(10)).extracting(HistoryEntry::id).containsExactly(second, first);
        assertThat(adapter().find(second)).hasValueSatisfying(e -> {
            assertThat(e.sourceDetail()).isEqualTo("192.168.1.23");
            assertThat(e.changes()).containsExactly(new HistoryEntry.Change("A", "1", "2"));
        });
        assertThat(adapter().contentBefore(second)).contains("A=1\n");
        assertThat(adapter().lastKnownContent()).contains("A=2\n");
    }

    @Test
    void onlyTheLastFiftyAreKeptWithTheirSnapshots() throws Exception {
        EnvHistoryFileAdapter history = adapter();
        for (int i = 0; i < 55; i++) {
            history.append(HistoryEntry.HistorySource.CLI, "fathy", List.of(), "before " + i, "after " + i);
        }
        assertThat(history.recent(100)).hasSize(EnvHistoryFileAdapter.KEEP);
        assertThat(history.find(1)).isEmpty();
        assertThat(history.contentBefore(55)).contains("before 54");
        try (var files = Files.list(data.resolve("env-history"))) {
            assertThat(files.count()).isEqualTo(EnvHistoryFileAdapter.KEEP * 2L);
        }
    }

    @Test
    void pendingRestartsSurviveARestartOfTheBackend() {
        PendingRestartFileAdapter pending = new PendingRestartFileAdapter(data, mapper);
        pending.replace(List.of(new PendingRestart("ALFRED_MEMORY", "2g", "3g", Instant.parse("2026-10-07T12:00:00Z"))));
        assertThat(new PendingRestartFileAdapter(data, mapper).all())
                .containsExactly(new PendingRestart("ALFRED_MEMORY", "2g", "3g", Instant.parse("2026-10-07T12:00:00Z")));
        pending.replace(List.of());
        assertThat(pending.all()).isEmpty();
    }
}
