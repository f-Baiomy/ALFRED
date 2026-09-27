package com.fathy.alfred.backend.scenarios.application.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.scenarios.application.port.in.CreateRunUseCase;
import com.fathy.alfred.backend.scenarios.application.port.in.CreateScenarioUseCase;
import com.fathy.alfred.backend.scenarios.application.port.in.DeleteScenarioUseCase;
import com.fathy.alfred.backend.scenarios.application.port.in.GetRunUseCase;
import com.fathy.alfred.backend.scenarios.application.port.in.GetScenarioUseCase;
import com.fathy.alfred.backend.scenarios.application.port.in.ListRunsUseCase;
import com.fathy.alfred.backend.scenarios.application.port.in.ListScenariosUseCase;
import com.fathy.alfred.backend.scenarios.application.port.in.UpdateScenarioUseCase;
import com.fathy.alfred.backend.scenarios.application.port.out.ScenarioNotificationPort;
import com.fathy.alfred.backend.scenarios.application.port.out.ScenarioRunStorePort;
import com.fathy.alfred.backend.scenarios.application.port.out.ScenarioStorePort;
import com.fathy.alfred.backend.scenarios.domain.model.NewRun;
import com.fathy.alfred.backend.scenarios.domain.model.NewScenario;
import com.fathy.alfred.backend.scenarios.domain.model.Run;
import com.fathy.alfred.backend.scenarios.domain.model.RunListItem;
import com.fathy.alfred.backend.scenarios.domain.model.Scenario;
import com.fathy.alfred.backend.scenarios.domain.model.ScenarioSummary;
import com.fathy.alfred.backend.scenarios.domain.model.ScenarioUpdate;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * Application core for scenarios and their runs (contracts/002-power-features section 3).
 * {@code definition}/{@code results} are opaque JSON as far as this slice is concerned - the only
 * thing it validates about them is their serialized size, since it is this slice's own SQLite
 * column (and eventually its own HTTP response body) that pays for an unbounded document.
 */
@Service
public class ScenariosService implements ListScenariosUseCase, GetScenarioUseCase, CreateScenarioUseCase,
        UpdateScenarioUseCase, DeleteScenarioUseCase, ListRunsUseCase, GetRunUseCase, CreateRunUseCase {

    /** contracts/002-power-features section 3: "name 1-80 chars". */
    static final int NAME_MAX_LENGTH = 80;

    /** contracts/002-power-features section 3: "definition and results each at most 20 MB serialized (400 above)". */
    static final long MAX_JSON_BYTES = 20L * 1024 * 1024;

    /** contracts/002-power-features section 3: "keeps newest 50 runs per scenario". */
    static final int RUN_RETENTION_LIMIT = 50;

    private final ScenarioStorePort scenarioStore;
    private final ScenarioRunStorePort runStore;
    private final ScenarioNotificationPort notificationPort;
    private final ObjectMapper objectMapper = new ObjectMapper();

    public ScenariosService(ScenarioStorePort scenarioStore, ScenarioRunStorePort runStore, ScenarioNotificationPort notificationPort) {
        this.scenarioStore = scenarioStore;
        this.runStore = runStore;
        this.notificationPort = notificationPort;
    }

    @Override
    public List<ScenarioSummary> listAll() {
        return scenarioStore.findAllSummaries();
    }

    @Override
    public Optional<Scenario> getById(String id) {
        return scenarioStore.findById(id);
    }

    @Override
    public Scenario create(NewScenario newScenario) {
        validateName(newScenario.name());
        validateJsonSize(newScenario.definition(), "definition");

        String id = UUID.randomUUID().toString();
        String now = Instant.now().toString();
        Scenario scenario = new Scenario(id, newScenario.name(), newScenario.description(), newScenario.definition(), now, now, null);
        Scenario saved = scenarioStore.save(scenario);
        notificationPort.notifyScenariosChanged();
        return saved;
    }

    @Override
    public Optional<Scenario> update(String id, ScenarioUpdate update) {
        validateName(update.name());
        validateJsonSize(update.definition(), "definition");

        return scenarioStore.findById(id).map(existing -> {
            Scenario updated = new Scenario(
                    existing.id(), update.name(), update.description(), update.definition(),
                    existing.createdAt(), Instant.now().toString(), existing.lastRun());
            Scenario saved = scenarioStore.save(updated);
            notificationPort.notifyScenariosChanged();
            return saved;
        });
    }

    @Override
    public boolean deleteById(String id) {
        if (!scenarioStore.existsById(id)) {
            return false;
        }
        // Runs first, then the scenario - the same child-before-parent ordering
        // backend-interception's SqliteStoredAnswersStoreAdapter.delete uses, since the pool
        // doesn't enforce foreign_keys ON DELETE CASCADE.
        runStore.deleteByScenarioId(id);
        boolean deleted = scenarioStore.deleteById(id);
        if (deleted) {
            notificationPort.notifyScenariosChanged();
        }
        return deleted;
    }

    @Override
    public Optional<List<RunListItem>> listRuns(String scenarioId) {
        if (!scenarioStore.existsById(scenarioId)) {
            return Optional.empty();
        }
        return Optional.of(runStore.findByScenarioId(scenarioId));
    }

    @Override
    public Optional<Run> getRun(String scenarioId, String runId) {
        if (!scenarioStore.existsById(scenarioId)) {
            return Optional.empty();
        }
        return runStore.findById(scenarioId, runId);
    }

    @Override
    public Optional<Run> createRun(String scenarioId, NewRun newRun) {
        if (!scenarioStore.existsById(scenarioId)) {
            return Optional.empty();
        }
        validateJsonSize(newRun.results(), "results");

        Run run = new Run(UUID.randomUUID().toString(), scenarioId, newRun.startedAt(), newRun.finishedAt(),
                newRun.summary(), newRun.results());
        Run saved = runStore.save(run, RUN_RETENTION_LIMIT);
        notificationPort.notifyScenariosChanged();
        return Optional.of(saved);
    }

    private static void validateName(String name) {
        if (name == null || name.isBlank()) {
            throw new IllegalArgumentException("name must not be blank");
        }
        if (name.length() > NAME_MAX_LENGTH) {
            throw new IllegalArgumentException("name must be at most " + NAME_MAX_LENGTH + " characters");
        }
    }

    private void validateJsonSize(JsonNode node, String fieldName) {
        if (node == null || node.isNull()) {
            return;
        }
        long bytes;
        try {
            bytes = objectMapper.writeValueAsBytes(node).length;
        } catch (Exception e) {
            // A JsonNode is always serializable - this can't actually happen, but fail closed
            // (reject) rather than silently let an unmeasurable document through.
            throw new IllegalArgumentException(fieldName + " could not be measured: " + e.getMessage());
        }
        if (bytes > MAX_JSON_BYTES) {
            throw new IllegalArgumentException(fieldName + " exceeds the " + (MAX_JSON_BYTES / (1024 * 1024)) + " MB limit");
        }
    }
}
