package com.fathy.alfred.backend.scenarios.adapter.in.web;

import com.fathy.alfred.backend.scenarios.application.port.in.CreateRunUseCase;
import com.fathy.alfred.backend.scenarios.application.port.in.CreateScenarioUseCase;
import com.fathy.alfred.backend.scenarios.application.port.in.DeleteScenarioUseCase;
import com.fathy.alfred.backend.scenarios.application.port.in.GetRunUseCase;
import com.fathy.alfred.backend.scenarios.application.port.in.GetScenarioUseCase;
import com.fathy.alfred.backend.scenarios.application.port.in.ListRunsUseCase;
import com.fathy.alfred.backend.scenarios.application.port.in.ListScenariosUseCase;
import com.fathy.alfred.backend.scenarios.application.port.in.UpdateScenarioUseCase;
import com.fathy.alfred.backend.scenarios.domain.model.Run;
import com.fathy.alfred.backend.scenarios.domain.model.RunListItem;
import com.fathy.alfred.backend.scenarios.domain.model.RunOutcome;
import com.fathy.alfred.backend.scenarios.domain.model.Scenario;
import com.fathy.alfred.backend.scenarios.domain.model.ScenarioUpdate;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import java.util.List;
import java.util.Optional;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@WebMvcTest(ScenariosController.class)
class ScenariosControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private ListScenariosUseCase listScenariosUseCase;
    @MockBean
    private GetScenarioUseCase getScenarioUseCase;
    @MockBean
    private CreateScenarioUseCase createScenarioUseCase;
    @MockBean
    private UpdateScenarioUseCase updateScenarioUseCase;
    @MockBean
    private DeleteScenarioUseCase deleteScenarioUseCase;
    @MockBean
    private ListRunsUseCase listRunsUseCase;
    @MockBean
    private GetRunUseCase getRunUseCase;
    @MockBean
    private CreateRunUseCase createRunUseCase;

    private static Scenario scenario(String id) {
        return new Scenario(id, "Book flow", "desc", null, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", null);
    }

    private static Run run(String id, String scenarioId) {
        return new Run(id, scenarioId, "t1", "t2", new RunOutcome(1, 1, 0, 0), null);
    }

    @Test
    void rejectsAScenarioWithABlankName() throws Exception {
        mockMvc.perform(post("/scenarios")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"name":"","definition":{}}
                                """))
                .andExpect(status().isBadRequest());
    }

    @Test
    void rejectsAScenarioMissingADefinition() throws Exception {
        mockMvc.perform(post("/scenarios")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"name":"Book flow"}
                                """))
                .andExpect(status().isBadRequest());
    }

    @Test
    void returnsBadRequestWhenTheServiceRejectsTheDefinitionSize() throws Exception {
        when(createScenarioUseCase.create(any())).thenThrow(new IllegalArgumentException("definition exceeds the 20 MB limit"));

        mockMvc.perform(post("/scenarios")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"name":"Book flow","definition":{}}
                                """))
                .andExpect(status().isBadRequest());
    }

    @Test
    void createsAScenarioAndReturns201() throws Exception {
        when(createScenarioUseCase.create(any())).thenReturn(scenario("s1"));

        mockMvc.perform(post("/scenarios")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"name":"Book flow","description":"desc","definition":{"version":1}}
                                """))
                .andExpect(status().isCreated());
    }

    @Test
    void listsScenarios() throws Exception {
        when(listScenariosUseCase.listAll()).thenReturn(List.of());

        mockMvc.perform(get("/scenarios"))
                .andExpect(status().isOk());
    }

    @Test
    void returnsNotFoundWhenGettingAMissingScenario() throws Exception {
        when(getScenarioUseCase.getById(eq("missing"))).thenReturn(Optional.empty());

        mockMvc.perform(get("/scenarios/missing"))
                .andExpect(status().isNotFound());
    }

    @Test
    void returnsOkWhenGettingAnExistingScenario() throws Exception {
        when(getScenarioUseCase.getById(eq("s1"))).thenReturn(Optional.of(scenario("s1")));

        mockMvc.perform(get("/scenarios/s1"))
                .andExpect(status().isOk());
    }

    @Test
    void returnsNotFoundWhenUpdatingAMissingScenario() throws Exception {
        when(updateScenarioUseCase.update(eq("missing"), any(ScenarioUpdate.class))).thenReturn(Optional.empty());

        mockMvc.perform(put("/scenarios/missing")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"name":"Book flow","definition":{}}
                                """))
                .andExpect(status().isNotFound());
    }

    @Test
    void returnsOkWhenUpdatingAnExistingScenario() throws Exception {
        when(updateScenarioUseCase.update(eq("s1"), any(ScenarioUpdate.class))).thenReturn(Optional.of(scenario("s1")));

        mockMvc.perform(put("/scenarios/s1")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"name":"Book flow","definition":{}}
                                """))
                .andExpect(status().isOk());
    }

    @Test
    void returnsNotFoundWhenDeletingAMissingScenario() throws Exception {
        when(deleteScenarioUseCase.deleteById(eq("missing"))).thenReturn(false);

        mockMvc.perform(delete("/scenarios/missing"))
                .andExpect(status().isNotFound());
    }

    @Test
    void returnsNoContentWhenDeletingAnExistingScenario() throws Exception {
        when(deleteScenarioUseCase.deleteById(eq("s1"))).thenReturn(true);

        mockMvc.perform(delete("/scenarios/s1"))
                .andExpect(status().isNoContent());
    }

    @Test
    void returnsNotFoundWhenListingRunsOfAMissingScenario() throws Exception {
        when(listRunsUseCase.listRuns(eq("missing"))).thenReturn(Optional.empty());

        mockMvc.perform(get("/scenarios/missing/runs"))
                .andExpect(status().isNotFound());
    }

    @Test
    void listsRunsOfAnExistingScenario() throws Exception {
        when(listRunsUseCase.listRuns(eq("s1"))).thenReturn(Optional.of(List.of(
                new RunListItem("r1", "s1", "t1", "t2", new RunOutcome(1, 1, 0, 0)))));

        mockMvc.perform(get("/scenarios/s1/runs"))
                .andExpect(status().isOk());
    }

    @Test
    void returnsNotFoundWhenGettingAMissingRun() throws Exception {
        when(getRunUseCase.getRun(eq("s1"), eq("missing"))).thenReturn(Optional.empty());

        mockMvc.perform(get("/scenarios/s1/runs/missing"))
                .andExpect(status().isNotFound());
    }

    @Test
    void returnsOkWhenGettingAnExistingRun() throws Exception {
        when(getRunUseCase.getRun(eq("s1"), eq("r1"))).thenReturn(Optional.of(run("r1", "s1")));

        mockMvc.perform(get("/scenarios/s1/runs/r1"))
                .andExpect(status().isOk());
    }

    @Test
    void returnsNotFoundWhenCreatingARunForAMissingScenario() throws Exception {
        when(createRunUseCase.createRun(eq("missing"), any())).thenReturn(Optional.empty());

        mockMvc.perform(post("/scenarios/missing/runs")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"startedAt":"t1","finishedAt":"t2","summary":{"total":1,"passed":1,"failed":0,"errored":0}}
                                """))
                .andExpect(status().isNotFound());
    }

    @Test
    void createsARunAndReturns201() throws Exception {
        when(createRunUseCase.createRun(eq("s1"), any())).thenReturn(Optional.of(run("r1", "s1")));

        mockMvc.perform(post("/scenarios/s1/runs")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"startedAt":"t1","finishedAt":"t2","summary":{"total":1,"passed":1,"failed":0,"errored":0}}
                                """))
                .andExpect(status().isCreated());
    }

    @Test
    void returnsBadRequestWhenTheServiceRejectsTheRunResultsSize() throws Exception {
        when(createRunUseCase.createRun(eq("s1"), any())).thenThrow(new IllegalArgumentException("results exceeds the 20 MB limit"));

        mockMvc.perform(post("/scenarios/s1/runs")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"startedAt":"t1","finishedAt":"t2","summary":{"total":1,"passed":1,"failed":0,"errored":0}}
                                """))
                .andExpect(status().isBadRequest());
    }
}
