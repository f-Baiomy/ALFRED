package com.fathy.alfred.backend.relive.adapter.out.sqlite;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.relive.domain.model.CycleVersion;
import com.fathy.alfred.backend.relive.domain.model.FrozenCall;
import com.fathy.alfred.backend.relive.domain.model.GlobalRulesSelection;
import com.fathy.alfred.backend.relive.domain.model.LiveCall;
import com.fathy.alfred.backend.relive.domain.model.NoiseRule;
import com.fathy.alfred.backend.relive.domain.model.ReliveCycle;
import com.fathy.alfred.backend.relive.domain.model.ReliveCycleSummary;
import com.fathy.alfred.backend.relive.domain.model.ReliveSettings;
import com.fathy.alfred.backend.relive.domain.model.Run;
import com.fathy.alfred.backend.relive.domain.model.RunStatus;
import com.fathy.alfred.backend.relive.domain.model.RunSummary;
import com.fathy.alfred.backend.relive.domain.model.StepResult;
import com.fathy.alfred.backend.relive.domain.model.StepState;
import com.fathy.alfred.backend.relive.domain.model.UnexpectedCallsPolicy;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.util.ReflectionTestUtils;

import java.nio.file.Path;
import java.sql.DriverManager;
import java.util.Collections;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;

/** Round-trips through a temp-file SQLite DB (constitution: SQLite adapters don't cache). */
class SqliteReliveStoreAdaptersTest {

    private SqliteReliveRepository repository;
    private SqliteReliveCycleStoreAdapter cycleStore;
    private SqliteReliveRunStoreAdapter runStore;
    private SqliteLiveCallStoreAdapter liveCallStore;
    private final ObjectMapper objectMapper = new ObjectMapper();

    @BeforeEach
    void setUp(@TempDir Path tempDir) {
        repository = new SqliteReliveRepository();
        ReflectionTestUtils.setField(repository, "dbFile", tempDir.resolve("relive.db").toString());
        repository.init();
        cycleStore = new SqliteReliveCycleStoreAdapter(repository, objectMapper);
        runStore = new SqliteReliveRunStoreAdapter(repository, objectMapper);
        liveCallStore = new SqliteLiveCallStoreAdapter(repository, objectMapper);
    }

    private ReliveCycle newCycle(String id, boolean isTransient) {
        String body = "x".repeat(30_000); // ~30 KB, per T010
        JsonNode ruleDoc = objectMapper.createObjectNode().put("name", "call rule");
        var callRule = new com.fathy.alfred.backend.relive.domain.model.CycleRule(ruleDoc, null);
        var recording = new FrozenCall("POST", "https://api.supplier-a.com/v2/search",
                Collections.emptyMap(), body, 200, Collections.emptyMap(), body, "2026-09-27T10:00:00Z",
                420, null, null, "odeysys", "outbound");
        var step = new com.fathy.alfred.backend.relive.domain.model.Step(
                "s-search", null, "POST /v2/search", true, false, "inbound", "odeysys", callRule,
                "BLOCK", recording, new com.fathy.alfred.backend.relive.domain.model.StepSource(null, null, "inbound"),
                objectMapper.createArrayNode(), objectMapper.createArrayNode(), List.of(), null, null);
        return new ReliveCycle(id, "Book flow", "desc", List.of(step), List.of(), List.of(),
                new GlobalRulesSelection("NONE", List.of()),
                new ReliveSettings("LIVE", "HOLD", "CONTINUE", "AUTOMATIC", List.of()),
                List.of(), new UnexpectedCallsPolicy("BLOCK", List.of(), "BLOCK"),
                "2026-09-27T10:00:00Z", "2026-09-27T10:00:00Z", isTransient, null);
    }

    private ReliveCycle cycleWithChildAndRule(String id) {
        ReliveCycle base = newCycle(id, false);
        var parent = base.steps().get(0);
        var child = new com.fathy.alfred.backend.relive.domain.model.Step(
                "s-child", parent.key(), "Supplier A", true, false, "outbound", "Supplier A", parent.callRule(),
                "BLOCK", parent.recording(), parent.source(), parent.extract(), parent.assertions(), List.of(), null, null);
        return new ReliveCycle(base.id(), base.name(), base.description(), List.of(parent, child),
                base.variables(), List.of(parent.callRule()), base.globalRules(), base.settings(), base.noise(),
                base.unexpectedCalls(), base.createdAt(), base.updatedAt(), base.isTransient(), base.lastRun());
    }

    @Test
    void roundTripsACycle() {
        ReliveCycle saved = cycleStore.save(newCycle("c-1", false));

        Optional<ReliveCycle> found = cycleStore.findById("c-1");
        assertThat(found).isPresent();
        assertThat(found.get().name()).isEqualTo("Book flow");
        assertThat(found.get().steps()).hasSize(1);
        assertThat(found.get().steps().get(0).recording().requestBody()).hasSize(30_000);
        assertThat(saved.id()).isEqualTo("c-1");
    }

    @Test
    void aRunKeepsItsStartStepAndSeedVariables() {
        // Review B5: both were dropped on write, so "Run from here" re-sent every earlier step.
        var seed = List.of(new com.fathy.alfred.backend.relive.domain.model.VariableChange("searchId", "s-9", "s-search", "t0"));
        var run = new com.fathy.alfred.backend.relive.domain.model.Run("r-1", "c-1", "AUTOMATIC",
                com.fathy.alfred.backend.relive.domain.model.RunStatus.RUNNING, "t0", null, newCycle("c-1", false),
                "s-book", seed, seed, null, null, List.of(), List.of());

        var created = runStore.create(run);

        assertThat(created.fromStepKey()).isEqualTo("s-book");
        assertThat(created.seedVariables()).extracting(v -> v.value()).containsExactly("s-9");
        assertThat(runStore.listByCycleId("c-1", 10).get(0).fromStepKey()).isEqualTo("s-book");
    }

    @Test
    void stateUpdatesLeaveTheDefinitionAloneAndOutcomesNeedNoBodies() {
        var run = new com.fathy.alfred.backend.relive.domain.model.Run("r-2", "c-1", "AUTOMATIC",
                com.fathy.alfred.backend.relive.domain.model.RunStatus.RUNNING, "t0", null, newCycle("c-1", false),
                null, List.of(), List.of(), null, null, List.of(), List.of());
        runStore.create(run);
        var later = new com.fathy.alfred.backend.relive.domain.model.Run("r-2", "c-1", "AUTOMATIC",
                com.fathy.alfred.backend.relive.domain.model.RunStatus.STOPPED, "t0", "t9", null,
                null, List.of(), List.of(), null, null, List.of(), List.of());

        runStore.updateState(later);
        runStore.putStepResult(new com.fathy.alfred.backend.relive.domain.model.StepResult("r-2", "s-search", 1,
                com.fathy.alfred.backend.relive.domain.model.StepState.COMPLETED, "LIVE", "HEADER", null, null, null,
                List.of(), List.of(), List.of(), List.of(), null, "t0", "t1", 5L, null, List.of(), null, List.of(), null));

        var stored = runStore.findById("r-2").orElseThrow();
        assertThat(stored.status()).isEqualTo(com.fathy.alfred.backend.relive.domain.model.RunStatus.STOPPED);
        assertThat(stored.definition().steps().get(0).recording().requestBody()).hasSize(30_000);
        assertThat(runStore.listStepOutcomes("r-2")).singleElement()
                .satisfies(o -> assertThat(o.attribution()).isEqualTo("HEADER"));
    }

    @Test
    void listDoesNotReadBodies() {
        cycleStore.save(cycleWithChildAndRule("c-1"));
        List<ReliveCycleSummary> summaries = cycleStore.listSummaries();
        assertThat(summaries).hasSize(1);
        assertThat(summaries.get(0).stepCount()).isEqualTo(2);
        assertThat(summaries.get(0).childCount()).isEqualTo(1);
        assertThat(summaries.get(0).cycleRuleCount()).isEqualTo(1);
        assertThat(summaries.get(0).name()).isEqualTo("Book flow");
    }

    @Test
    void existingDatabaseBackfillsListBadges(@TempDir Path tempDir) throws Exception {
        Path legacyFile = tempDir.resolve("legacy-relive.db");
        ReliveCycle existing = cycleWithChildAndRule("old-cycle");
        try (var connection = DriverManager.getConnection("jdbc:sqlite:" + legacyFile)) {
            connection.createStatement().execute("""
                    CREATE TABLE relive_cycles (
                      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, definition_json TEXT NOT NULL,
                      is_transient INTEGER NOT NULL DEFAULT 0, step_count INTEGER NOT NULL DEFAULT 0,
                      live_count INTEGER NOT NULL DEFAULT 0, last_run_json TEXT,
                      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                    )
                    """);
            try (var insert = connection.prepareStatement("""
                    INSERT INTO relive_cycles
                    (id, name, description, definition_json, step_count, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """)) {
                insert.setString(1, existing.id());
                insert.setString(2, existing.name());
                insert.setString(3, existing.description());
                insert.setString(4, objectMapper.writeValueAsString(existing));
                insert.setInt(5, existing.steps().size());
                insert.setString(6, existing.createdAt());
                insert.setString(7, existing.updatedAt());
                insert.executeUpdate();
            }
        }

        var upgraded = new SqliteReliveRepository();
        ReflectionTestUtils.setField(upgraded, "dbFile", legacyFile.toString());
        upgraded.init();
        try {
            ReliveCycleSummary summary = new SqliteReliveCycleStoreAdapter(upgraded, objectMapper).listSummaries().get(0);
            assertThat(summary.childCount()).isEqualTo(1);
            assertThat(summary.cycleRuleCount()).isEqualTo(1);
        } finally {
            upgraded.close();
        }
    }

    @Test
    void versionPruningKeepsTheNewestTen() {
        for (int i = 1; i <= 15; i++) {
            CycleVersion version = new CycleVersion("c-1", i, "2026-09-27T1" + (i % 10) + ":00:00Z", "REBUILD_REFRESH", newCycle("c-1", false));
            cycleStore.saveVersion(version, 10);
        }
        List<CycleVersion> versions = cycleStore.listVersions("c-1");
        assertThat(versions).hasSize(10);
        assertThat(versions.get(0).version()).isEqualTo(15);
        assertThat(versions.get(9).version()).isEqualTo(6);
    }

    private Run newRun(String id, String cycleId) {
        RunSummary summary = new RunSummary(1, 0, 0, 0, 0, 0, 0, 0, 0, 0);
        return new Run(id, cycleId, "AUTOMATIC", RunStatus.RUNNING, "2026-09-27T10:00:00Z", null,
                newCycle(cycleId, false), null, List.of(), List.of(), summary, null, List.of(), List.of());
    }

    @Test
    void runPruningKeepsNewestFiftyAndSizeCap() {
        runStore.create(newRun("r-going", "c-1"));
        for (int i = 1; i <= 55; i++) {
            runStore.create(finished(newRun("r-" + i, "c-1")));
        }
        List<Run> listed = runStore.listByCycleId("c-1", 100);
        assertThat(listed).hasSize(56);

        runStore.pruneRuns("c-1", 50, Long.MAX_VALUE);
        assertThat(runStore.listByCycleId("c-1", 100)).hasSize(51);

        // Size cap: each run's definition body is ~30 KB: cap far below that forces heavy pruning.
        runStore.pruneRuns("c-1", 50, 50_000);
        List<Run> kept = runStore.listByCycleId("c-1", 100);
        assertThat(kept.size()).isLessThan(50);
        // Review B27: the run still going and the newest finished run always survive.
        assertThat(kept).extracting(Run::id).contains("r-going", "r-55");
    }

    private Run finished(Run run) {
        return new Run(run.id(), run.cycleId(), run.driver(), RunStatus.COMPLETED, run.startedAt(), "t9",
                run.definition(), null, List.of(), List.of(), run.summary(), null, List.of(), List.of());
    }

    @Test
    void stepResultsRoundTrip() {
        runStore.create(newRun("r-1", "c-1"));
        StepResult result = new StepResult("r-1", "s-search", 1, StepState.COMPLETED, "REPLAY", "HEADER",
                null, null, null, List.of(), List.of(), List.of(), List.of(), null,
                "2026-09-27T10:00:00Z", "2026-09-27T10:00:01Z", 1000L, null, List.of(), null, List.of(), null);
        runStore.putStepResult(result);
        List<StepResult> results = runStore.listStepResults("r-1");
        assertThat(results).hasSize(1);
        assertThat(results.get(0).state()).isEqualTo(StepState.COMPLETED);
    }

    @Test
    void liveCallsAreNeverPrunedByRunPruning() {
        LiveCall call = new LiveCall("lv-1", "c-1", "r-1", "s-search", "LIVE", null,
                objectMapper.createObjectNode().put("method", "POST").put("url", "https://api.supplier-a.com"),
                objectMapper.createObjectNode().put("status", 200), 200, 900, "2026-09-27T10:00:00Z");
        liveCallStore.add(call);

        for (int i = 1; i <= 60; i++) {
            runStore.create(newRun("r-" + i, "c-1"));
        }
        runStore.pruneRuns("c-1", 5, 1);

        assertThat(liveCallStore.list("c-1", 100)).hasSize(1);
        assertThat(liveCallStore.totalBytes("c-1")).isGreaterThan(0);
    }

    @Test
    void liveCallDeletedOnlyByUser() {
        LiveCall call = new LiveCall("lv-2", "c-1", "r-1", null, "UNEXPECTED", null,
                objectMapper.createObjectNode(), objectMapper.createObjectNode(), 502, 10, "2026-09-27T10:00:00Z");
        liveCallStore.add(call);
        assertThat(liveCallStore.findById("lv-2")).isPresent();
        assertThat(liveCallStore.deleteById("lv-2")).isTrue();
        assertThat(liveCallStore.findById("lv-2")).isEmpty();
    }
}
