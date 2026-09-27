package com.fathy.alfred.backend.scenarios.adapter.out.sqlite;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.scenarios.domain.model.Run;
import com.fathy.alfred.backend.scenarios.domain.model.RunOutcome;
import com.fathy.alfred.backend.scenarios.domain.model.Scenario;
import com.fathy.alfred.backend.scenarios.domain.model.ScenarioSummary;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

class SqliteScenarioStoreAdapterTest {

    @TempDir
    Path tempDir;

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final List<SqliteScenariosRepository> opened = new ArrayList<>();

    @AfterEach
    void closeRepositories() throws InterruptedException {
        opened.forEach(SqliteScenariosRepository::close);
        Thread.sleep(50);
    }

    private SqliteScenariosRepository repository() throws Exception {
        SqliteScenariosRepository repository = new SqliteScenariosRepository();
        Field field = SqliteScenariosRepository.class.getDeclaredField("dbFile");
        field.setAccessible(true);
        field.set(repository, tempDir.resolve("scenarios.db").toString());
        repository.init();
        opened.add(repository);
        return repository;
    }

    private JsonNode definition(String value) {
        return objectMapper.createObjectNode().put("field", value);
    }

    private static Scenario scenario(String id, String name, JsonNode definition) {
        return new Scenario(id, name, "desc", definition, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", null);
    }

    @Test
    void saveThenFindByIdRoundTripsIncludingTheDefinition() throws Exception {
        SqliteScenariosRepository repository = repository();
        SqliteScenarioStoreAdapter adapter = new SqliteScenarioStoreAdapter(repository);

        adapter.save(scenario("s1", "Book flow", definition("v1")));

        Optional<Scenario> found = adapter.findById("s1");
        assertThat(found).isPresent();
        assertThat(found.get().name()).isEqualTo("Book flow");
        assertThat(found.get().definition().get("field").asText()).isEqualTo("v1");
        assertThat(found.get().lastRun()).isNull();
    }

    @Test
    void findByIdReturnsEmptyForAnUnknownId() throws Exception {
        SqliteScenarioStoreAdapter adapter = new SqliteScenarioStoreAdapter(repository());

        assertThat(adapter.findById("missing")).isEmpty();
    }

    @Test
    void saveUpsertsAnExistingScenarioAndPreservesCreatedAt() throws Exception {
        SqliteScenarioStoreAdapter adapter = new SqliteScenarioStoreAdapter(repository());
        adapter.save(scenario("s1", "Old name", definition("v1")));

        adapter.save(new Scenario("s1", "New name", "new desc", definition("v2"), "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z", null));

        Optional<Scenario> found = adapter.findById("s1");
        assertThat(found).isPresent();
        assertThat(found.get().name()).isEqualTo("New name");
        assertThat(found.get().definition().get("field").asText()).isEqualTo("v2");
        assertThat(found.get().createdAt()).isEqualTo("2026-01-01T00:00:00Z");
        assertThat(adapter.findAllSummaries()).hasSize(1);
    }

    @Test
    void existsByIdReflectsPresence() throws Exception {
        SqliteScenarioStoreAdapter adapter = new SqliteScenarioStoreAdapter(repository());
        adapter.save(scenario("s1", "Book flow", definition("v1")));

        assertThat(adapter.existsById("s1")).isTrue();
        assertThat(adapter.existsById("missing")).isFalse();
    }

    @Test
    void deleteByIdRemovesOnlyTheMatchingScenario() throws Exception {
        SqliteScenarioStoreAdapter adapter = new SqliteScenarioStoreAdapter(repository());
        adapter.save(scenario("s1", "A", definition("v1")));
        adapter.save(scenario("s2", "B", definition("v1")));

        assertThat(adapter.deleteById("s1")).isTrue();

        assertThat(adapter.findAllSummaries()).extracting(ScenarioSummary::id).containsExactly("s2");
        assertThat(adapter.deleteById("missing")).isFalse();
    }

    @Test
    void findAllSummariesOmitsTheDefinitionButIncludesLastRun() throws Exception {
        SqliteScenariosRepository repository = repository();
        SqliteScenarioStoreAdapter scenarioAdapter = new SqliteScenarioStoreAdapter(repository);
        SqliteScenarioRunStoreAdapter runAdapter = new SqliteScenarioRunStoreAdapter(repository);
        scenarioAdapter.save(scenario("s1", "Book flow", definition("v1")));

        List<ScenarioSummary> beforeAnyRun = scenarioAdapter.findAllSummaries();
        assertThat(beforeAnyRun).hasSize(1);
        assertThat(beforeAnyRun.get(0).lastRun()).isNull();

        Run run = new Run(UUID.randomUUID().toString(), "s1", "t1", "t2", new RunOutcome(2, 1, 1, 0), definition("result"));
        runAdapter.save(run, 50);

        List<ScenarioSummary> afterRun = scenarioAdapter.findAllSummaries();
        assertThat(afterRun.get(0).lastRun()).isEqualTo(new RunOutcome(2, 1, 1, 0));

        Optional<Scenario> detail = scenarioAdapter.findById("s1");
        assertThat(detail).isPresent();
        assertThat(detail.get().lastRun()).isEqualTo(new RunOutcome(2, 1, 1, 0));
        assertThat(detail.get().definition()).isNotNull();
    }

    @Test
    void findAllSummariesOrdersNewestFirst() throws Exception {
        SqliteScenarioStoreAdapter adapter = new SqliteScenarioStoreAdapter(repository());
        adapter.save(scenario("s1", "First", definition("v1")));
        adapter.save(scenario("s2", "Second", definition("v1")));

        assertThat(adapter.findAllSummaries()).extracting(ScenarioSummary::id).containsExactly("s2", "s1");
    }
}
