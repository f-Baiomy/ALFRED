package com.fathy.alfred.backend.storage;

import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/** Where the space goes: endpoints, largest calls, projects, repeats, and what each day added. */
class StorageInsightsTest {

    private static final Instant NOW = Instant.parse("2026-10-10T12:00:00Z");

    private static StorageInsights.CallRow row(String dir, String id, String method, String url, int status, String project, long bytes, String at) {
        return new StorageInsights.CallRow(dir, id, method, url, status, project, bytes, at);
    }

    @Test
    void groupsEndpointsWithoutTheirQueryAndRanksThemBySize() {
        List<StorageInsights.CallRow> rows = List.of(
                row("inbound", "a", "GET", "/app/report?id=1", 200, "odeysys", 3_000_000, "2026-10-10T10:00:00Z"),
                row("inbound", "b", "GET", "/app/report?id=2", 200, "odeysys", 3_000_000, "2026-10-10T10:01:00Z"),
                row("outbound", "c", "POST", "https://s.com/rates", 200, "s.com", 100, "2026-10-10T10:02:00Z"));

        StorageInsights.Insights i = StorageInsights.analyse(rows, NOW);

        assertThat(i.endpoints().get(0).path()).isEqualTo("/app/report");
        assertThat(i.endpoints().get(0).calls()).isEqualTo(2);
        assertThat(i.endpoints().get(0).ids()).containsExactly("a", "b");
        assertThat(i.endpoints().get(0).note()).contains("MB in each call");
        assertThat(i.largest().get(0).bytes()).isEqualTo(3_000_000);
        assertThat(i.projects()).extracting(StorageInsights.Group::project).containsExactly("odeysys", "s.com");
    }

    @Test
    void aRepeatKeepsItsNewestCopy() {
        List<StorageInsights.CallRow> rows = List.of(
                row("inbound", "old", "GET", "/hb", 200, "o", 500, "2026-10-10T10:00:00Z"),
                row("inbound", "mid", "GET", "/hb", 200, "o", 500, "2026-10-10T10:00:02Z"),
                row("inbound", "new", "GET", "/hb", 200, "o", 500, "2026-10-10T10:00:04Z"),
                row("inbound", "other", "GET", "/hb", 200, "o", 900, "2026-10-10T10:00:06Z"));

        StorageInsights.Insights i = StorageInsights.analyse(rows, NOW);

        assertThat(i.repeats()).hasSize(1);
        assertThat(i.repeats().get(0).ids()).containsExactly("old", "mid");
        assertThat(i.repeatBytes()).isEqualTo(1000);
        assertThat(i.repeatCalls()).isEqualTo(2);
    }

    @Test
    void namesPreflightsHealthChecksAndPolling() {
        List<StorageInsights.CallRow> rows = new ArrayList<>();
        rows.add(row("inbound", "o1", "OPTIONS", "/api/x", 204, "o", 10, "2026-10-10T10:00:00Z"));
        rows.add(row("inbound", "h1", "GET", "/actuator/health", 200, "o", 10, "2026-10-10T10:00:00Z"));
        for (int s = 0; s < 120; s++) {
            rows.add(row("inbound", "p" + s, "GET", "/heartbeat", 200, "o", 10, Instant.parse("2026-10-10T10:00:00Z").plusSeconds(2L * s).toString()));
        }

        StorageInsights.Insights i = StorageInsights.analyse(rows, NOW);

        assertThat(i.endpoints()).anySatisfy(g -> assertThat(g.note()).isEqualTo("CORS preflight - hidden in the call lists"));
        assertThat(i.endpoints()).anySatisfy(g -> assertThat(g.note()).isEqualTo("health check"));
        assertThat(i.endpoints()).anySatisfy(g -> assertThat(g.note()).isEqualTo("called about every 2 s"));
    }

    @Test
    void countsWhatEachOfTheLast30DaysAddedAndTheRecentRate() {
        List<StorageInsights.CallRow> rows = List.of(
                row("inbound", "a", "GET", "/x", 200, "o", 1000, "2026-10-10T08:00:00+00:00"),
                row("outbound", "b", "GET", "/y", 200, "s", 500, "2026-10-09T08:00:00Z"),
                row("inbound", "old", "GET", "/x", 200, "o", 99, "2026-08-01T08:00:00Z"));

        StorageInsights.Insights i = StorageInsights.analyse(rows, NOW);

        assertThat(i.days()).hasSize(StorageInsights.DAYS);
        assertThat(i.days().get(StorageInsights.DAYS - 1)).isEqualTo(new StorageInsights.Day("2026-10-10", 1000, 0, 1, 0));
        assertThat(i.days().get(StorageInsights.DAYS - 2).outboundBytes()).isEqualTo(500);
        assertThat(i.perDayBytes()).isEqualTo(750);
    }
}
