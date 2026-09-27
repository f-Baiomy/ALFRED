package com.fathy.alfred.backend.scenarios.application.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.scenarios.application.port.out.ScenarioNotificationPort;
import com.fathy.alfred.backend.scenarios.application.port.out.ScenarioRunStorePort;
import com.fathy.alfred.backend.scenarios.application.port.out.ScenarioStorePort;
import com.fathy.alfred.backend.scenarios.domain.model.NewRun;
import com.fathy.alfred.backend.scenarios.domain.model.NewScenario;
import com.fathy.alfred.backend.scenarios.domain.model.Run;
import com.fathy.alfred.backend.scenarios.domain.model.RunListItem;
import com.fathy.alfred.backend.scenarios.domain.model.RunOutcome;
import com.fathy.alfred.backend.scenarios.domain.model.Scenario;
import com.fathy.alfred.backend.scenarios.domain.model.ScenarioSummary;
import com.fathy.alfred.backend.scenarios.domain.model.ScenarioUpdate;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class ScenariosServiceTest {

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final ScenarioNotificationPort notificationPort = mock(ScenarioNotificationPort.class);

    private JsonNode smallDefinition() {
        return objectMapper.createObjectNode().put("version", 1);
    }

    /** A JSON document whose serialized form exceeds ScenariosService.MAX_JSON_BYTES (20 MB). */
    private JsonNode oversizedJson() {
        return objectMapper.getNodeFactory().textNode("x".repeat((int) ScenariosService.MAX_JSON_BYTES + 1));
    }

    private static Scenario scenario(String id, String name) {
        return new Scenario(id, name, "", null, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", null);
    }

    @Test
    void assignsIdAndTimestampsOnCreate() {
        ScenarioStorePort scenarioStore = mock(ScenarioStorePort.class);
        ScenarioRunStorePort runStore = mock(ScenarioRunStorePort.class);
        when(scenarioStore.save(any())).thenAnswer(invocation -> invocation.getArgument(0));
        ScenariosService service = new ScenariosService(scenarioStore, runStore, notificationPort);

        Scenario created = service.create(new NewScenario("Book flow", "desc", smallDefinition()));

        assertThat(created.id()).isNotBlank();
        assertThat(created.createdAt()).isNotBlank();
        assertThat(created.updatedAt()).isEqualTo(created.createdAt());
        assertThat(created.name()).isEqualTo("Book flow");
        assertThat(created.lastRun()).isNull();
        verify(notificationPort).notifyScenariosChanged();
    }

    @Test
    void rejectsABlankName() {
        ScenarioStorePort scenarioStore = mock(ScenarioStorePort.class);
        ScenarioRunStorePort runStore = mock(ScenarioRunStorePort.class);
        ScenariosService service = new ScenariosService(scenarioStore, runStore, notificationPort);

        assertThatThrownBy(() -> service.create(new NewScenario("  ", "desc", smallDefinition())))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> service.create(new NewScenario(null, "desc", smallDefinition())))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void rejectsANameLongerThan80Characters() {
        ScenarioStorePort scenarioStore = mock(ScenarioStorePort.class);
        ScenarioRunStorePort runStore = mock(ScenarioRunStorePort.class);
        ScenariosService service = new ScenariosService(scenarioStore, runStore, notificationPort);

        assertThatThrownBy(() -> service.create(new NewScenario("x".repeat(81), "desc", smallDefinition())))
                .isInstanceOf(IllegalArgumentException.class);
        // Boundary: exactly 80 is fine.
        when(scenarioStore.save(any())).thenAnswer(invocation -> invocation.getArgument(0));
        assertThat(service.create(new NewScenario("x".repeat(80), "desc", smallDefinition())).name()).hasSize(80);
    }

    @Test
    void rejectsADefinitionOver20Mb() {
        ScenarioStorePort scenarioStore = mock(ScenarioStorePort.class);
        ScenarioRunStorePort runStore = mock(ScenarioRunStorePort.class);
        ScenariosService service = new ScenariosService(scenarioStore, runStore, notificationPort);

        assertThatThrownBy(() -> service.create(new NewScenario("Book flow", "desc", oversizedJson())))
                .isInstanceOf(IllegalArgumentException.class);
        verify(notificationPort, never()).notifyScenariosChanged();
    }

    @Test
    void updateReplacesNameDescriptionAndDefinitionButKeepsIdAndCreatedAt() {
        ScenarioStorePort scenarioStore = mock(ScenarioStorePort.class);
        ScenarioRunStorePort runStore = mock(ScenarioRunStorePort.class);
        Scenario existing = scenario("s1", "Old name");
        when(scenarioStore.findById("s1")).thenReturn(Optional.of(existing));
        when(scenarioStore.save(any())).thenAnswer(invocation -> invocation.getArgument(0));
        ScenariosService service = new ScenariosService(scenarioStore, runStore, notificationPort);

        Optional<Scenario> updated = service.update("s1", new ScenarioUpdate("New name", "new desc", smallDefinition()));

        assertThat(updated).isPresent();
        assertThat(updated.get().id()).isEqualTo("s1");
        assertThat(updated.get().name()).isEqualTo("New name");
        assertThat(updated.get().description()).isEqualTo("new desc");
        assertThat(updated.get().createdAt()).isEqualTo(existing.createdAt());
        verify(notificationPort).notifyScenariosChanged();
    }

    @Test
    void updateReturnsEmptyWhenTheIdDoesNotExist() {
        ScenarioStorePort scenarioStore = mock(ScenarioStorePort.class);
        ScenarioRunStorePort runStore = mock(ScenarioRunStorePort.class);
        when(scenarioStore.findById("missing")).thenReturn(Optional.empty());
        ScenariosService service = new ScenariosService(scenarioStore, runStore, notificationPort);

        assertThat(service.update("missing", new ScenarioUpdate("New name", "d", smallDefinition()))).isEmpty();
        verify(notificationPort, never()).notifyScenariosChanged();
    }

    @Test
    void deleteCascadesToRunsBeforeDeletingTheScenario() {
        ScenarioStorePort scenarioStore = mock(ScenarioStorePort.class);
        ScenarioRunStorePort runStore = mock(ScenarioRunStorePort.class);
        when(scenarioStore.existsById("s1")).thenReturn(true);
        when(scenarioStore.deleteById("s1")).thenReturn(true);
        ScenariosService service = new ScenariosService(scenarioStore, runStore, notificationPort);

        assertThat(service.deleteById("s1")).isTrue();

        org.mockito.InOrder order = org.mockito.Mockito.inOrder(runStore, scenarioStore);
        order.verify(runStore).deleteByScenarioId("s1");
        order.verify(scenarioStore).deleteById("s1");
        verify(notificationPort).notifyScenariosChanged();
    }

    @Test
    void deleteReturnsFalseWhenTheScenarioDoesNotExistAndNeverTouchesRuns() {
        ScenarioStorePort scenarioStore = mock(ScenarioStorePort.class);
        ScenarioRunStorePort runStore = mock(ScenarioRunStorePort.class);
        when(scenarioStore.existsById("missing")).thenReturn(false);
        ScenariosService service = new ScenariosService(scenarioStore, runStore, notificationPort);

        assertThat(service.deleteById("missing")).isFalse();

        verify(runStore, never()).deleteByScenarioId(any());
        verify(notificationPort, never()).notifyScenariosChanged();
    }

    @Test
    void listRunsReturnsEmptyOptionalWhenTheScenarioDoesNotExist() {
        ScenarioStorePort scenarioStore = mock(ScenarioStorePort.class);
        ScenarioRunStorePort runStore = mock(ScenarioRunStorePort.class);
        when(scenarioStore.existsById("missing")).thenReturn(false);
        ScenariosService service = new ScenariosService(scenarioStore, runStore, notificationPort);

        assertThat(service.listRuns("missing")).isEmpty();
    }

    @Test
    void listRunsDelegatesToTheStoreWhenTheScenarioExists() {
        ScenarioStorePort scenarioStore = mock(ScenarioStorePort.class);
        ScenarioRunStorePort runStore = mock(ScenarioRunStorePort.class);
        when(scenarioStore.existsById("s1")).thenReturn(true);
        RunListItem item = new RunListItem("r1", "s1", "t1", "t2", new RunOutcome(1, 1, 0, 0));
        when(runStore.findByScenarioId("s1")).thenReturn(List.of(item));
        ScenariosService service = new ScenariosService(scenarioStore, runStore, notificationPort);

        assertThat(service.listRuns("s1")).contains(List.of(item));
    }

    @Test
    void createRunReturnsEmptyWhenTheScenarioDoesNotExist() {
        ScenarioStorePort scenarioStore = mock(ScenarioStorePort.class);
        ScenarioRunStorePort runStore = mock(ScenarioRunStorePort.class);
        when(scenarioStore.existsById("missing")).thenReturn(false);
        ScenariosService service = new ScenariosService(scenarioStore, runStore, notificationPort);

        assertThat(service.createRun("missing", new NewRun("t1", "t2", new RunOutcome(1, 1, 0, 0), smallDefinition()))).isEmpty();
        verify(runStore, never()).save(any(), anyInt());
    }

    @Test
    void createRunRejectsResultsOver20Mb() {
        ScenarioStorePort scenarioStore = mock(ScenarioStorePort.class);
        ScenarioRunStorePort runStore = mock(ScenarioRunStorePort.class);
        when(scenarioStore.existsById("s1")).thenReturn(true);
        ScenariosService service = new ScenariosService(scenarioStore, runStore, notificationPort);

        assertThatThrownBy(() -> service.createRun("s1", new NewRun("t1", "t2", new RunOutcome(1, 1, 0, 0), oversizedJson())))
                .isInstanceOf(IllegalArgumentException.class);
        verify(runStore, never()).save(any(), anyInt());
    }

    @Test
    void createRunPassesTheRetentionLimitToTheStoreAndAssignsIds() {
        ScenarioStorePort scenarioStore = mock(ScenarioStorePort.class);
        ScenarioRunStorePort runStore = mock(ScenarioRunStorePort.class);
        when(scenarioStore.existsById("s1")).thenReturn(true);
        when(runStore.save(any(), anyInt())).thenAnswer(invocation -> invocation.getArgument(0));
        ScenariosService service = new ScenariosService(scenarioStore, runStore, notificationPort);

        Optional<Run> created = service.createRun("s1", new NewRun("t1", "t2", new RunOutcome(3, 2, 1, 0), smallDefinition()));

        assertThat(created).isPresent();
        assertThat(created.get().id()).isNotBlank();
        assertThat(created.get().scenarioId()).isEqualTo("s1");

        ArgumentCaptor<Integer> limitCaptor = ArgumentCaptor.forClass(Integer.class);
        verify(runStore).save(any(), limitCaptor.capture());
        assertThat(limitCaptor.getValue()).isEqualTo(ScenariosService.RUN_RETENTION_LIMIT);
        verify(notificationPort).notifyScenariosChanged();
    }

    @Test
    void getRunReturnsEmptyWhenTheScenarioDoesNotExist() {
        ScenarioStorePort scenarioStore = mock(ScenarioStorePort.class);
        ScenarioRunStorePort runStore = mock(ScenarioRunStorePort.class);
        when(scenarioStore.existsById("missing")).thenReturn(false);
        ScenariosService service = new ScenariosService(scenarioStore, runStore, notificationPort);

        assertThat(service.getRun("missing", "r1")).isEmpty();
    }

    @Test
    void listAllDelegatesToTheStore() {
        ScenarioStorePort scenarioStore = mock(ScenarioStorePort.class);
        ScenarioRunStorePort runStore = mock(ScenarioRunStorePort.class);
        ScenarioSummary summary = new ScenarioSummary("s1", "Book flow", "", "t1", "t2", null);
        when(scenarioStore.findAllSummaries()).thenReturn(List.of(summary));
        ScenariosService service = new ScenariosService(scenarioStore, runStore, notificationPort);

        assertThat(service.listAll()).containsExactly(summary);
    }
}
