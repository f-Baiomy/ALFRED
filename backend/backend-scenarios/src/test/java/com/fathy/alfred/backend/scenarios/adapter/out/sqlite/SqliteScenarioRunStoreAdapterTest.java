package com.fathy.alfred.backend.scenarios.adapter.out.sqlite;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.scenarios.domain.model.Run;
import com.fathy.alfred.backend.scenarios.domain.model.RunListItem;
import com.fathy.alfred.backend.scenarios.domain.model.RunOutcome;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;

class SqliteScenarioRunStoreAdapterTest {

    @TempDir
    Path tempDir;

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final List<SqliteScenariosRepository> opened = new ArrayList<>();

    @AfterEach
    void closeRepositories() throws InterruptedException {
        opened.forEach(SqliteScenariosRepository::close);
        Thread.sleep(50);
    }

    private SqliteScenarioRunStoreAdapter adapter() throws Exception {
        SqliteScenariosRepository repository = new SqliteScenariosRepository();
        Field field = SqliteScenariosRepository.class.getDeclaredField("dbFile");
        field.setAccessible(true);
        field.set(repository, tempDir.resolve("scenarios.db").toString());
        repository.init();
        opened.add(repository);
        return new SqliteScenarioRunStoreAdapter(repository);
    }

    private JsonNode results(String value) {
        return objectMapper.createObjectNode().put("field", value);
    }

    private static Run run(String id, String scenarioId, JsonNode results) {
        return new Run(id, scenarioId, "t1", "t2", new RunOutcome(2, 1, 1, 0), results);
    }

    @Test
    void saveThenFindByIdRoundTripsIncludingResults() throws Exception {
        SqliteScenarioRunStoreAdapter adapter = adapter();

        adapter.save(run("r1", "s1", results("v1")), 50);

        Optional<Run> found = adapter.findById("s1", "r1");
        assertThat(found).isPresent();
        assertThat(found.get().summary()).isEqualTo(new RunOutcome(2, 1, 1, 0));
        assertThat(found.get().results().get("field").asText()).isEqualTo("v1");
    }

    @Test
    void findByIdReturnsEmptyForAnUnknownRunOrScenario() throws Exception {
        SqliteScenarioRunStoreAdapter adapter = adapter();
        adapter.save(run("r1", "s1", results("v1")), 50);

        assertThat(adapter.findById("s1", "missing")).isEmpty();
        assertThat(adapter.findById("other-scenario", "r1")).isEmpty();
    }

    @Test
    void findByScenarioIdOmitsResultsAndOrdersNewestFirst() throws Exception {
        SqliteScenarioRunStoreAdapter adapter = adapter();
        adapter.save(run("r1", "s1", results("v1")), 50);
        adapter.save(run("r2", "s1", results("v2")), 50);

        List<RunListItem> items = adapter.findByScenarioId("s1");

        assertThat(items).extracting(RunListItem::id).containsExactly("r2", "r1");
    }

    @Test
    void findByScenarioIdOnlyReturnsRunsOfThatScenario() throws Exception {
        SqliteScenarioRunStoreAdapter adapter = adapter();
        adapter.save(run("r1", "s1", results("v1")), 50);
        adapter.save(run("r2", "s2", results("v1")), 50);

        assertThat(adapter.findByScenarioId("s1")).extracting(RunListItem::id).containsExactly("r1");
    }

    @Test
    void saveEnforcesTheRetentionLimitPerScenario() throws Exception {
        SqliteScenarioRunStoreAdapter adapter = adapter();

        for (int i = 0; i < 5; i++) {
            adapter.save(run("r" + i, "s1", results("v" + i)), 3);
        }

        List<RunListItem> remaining = adapter.findByScenarioId("s1");
        assertThat(remaining).hasSize(3);
        assertThat(remaining).extracting(RunListItem::id).containsExactly("r4", "r3", "r2");
    }

    @Test
    void retentionLimitIsPerScenarioNotGlobal() throws Exception {
        SqliteScenarioRunStoreAdapter adapter = adapter();
        adapter.save(run("r1", "s1", results("v1")), 1);
        adapter.save(run("r2", "s2", results("v1")), 1);

        assertThat(adapter.findByScenarioId("s1")).extracting(RunListItem::id).containsExactly("r1");
        assertThat(adapter.findByScenarioId("s2")).extracting(RunListItem::id).containsExactly("r2");
    }

    @Test
    void deleteByScenarioIdRemovesOnlyThatScenariosRuns() throws Exception {
        SqliteScenarioRunStoreAdapter adapter = adapter();
        adapter.save(run("r1", "s1", results("v1")), 50);
        adapter.save(run("r2", "s2", results("v1")), 50);

        adapter.deleteByScenarioId("s1");

        assertThat(adapter.findByScenarioId("s1")).isEmpty();
        assertThat(adapter.findByScenarioId("s2")).extracting(RunListItem::id).containsExactly("r2");
    }
}
