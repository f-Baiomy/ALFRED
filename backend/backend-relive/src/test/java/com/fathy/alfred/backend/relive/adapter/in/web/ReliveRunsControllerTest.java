package com.fathy.alfred.backend.relive.adapter.in.web;

import com.fathy.alfred.backend.relive.application.port.in.FinishRunUseCase;
import com.fathy.alfred.backend.relive.application.port.in.GetRunUseCase;
import com.fathy.alfred.backend.relive.application.port.in.HoldRunUseCase;
import com.fathy.alfred.backend.relive.application.port.in.ListRunsUseCase;
import com.fathy.alfred.backend.relive.application.port.in.ManageReliveCyclesUseCase;
import com.fathy.alfred.backend.relive.application.port.in.RecordStepResultUseCase;
import com.fathy.alfred.backend.relive.application.port.in.ResumeRunUseCase;
import com.fathy.alfred.backend.relive.application.port.in.RunBlockedException;
import com.fathy.alfred.backend.relive.application.port.in.RunDefinitionConflictException;
import com.fathy.alfred.backend.relive.application.port.in.RunLeaseHeldException;
import com.fathy.alfred.backend.relive.application.port.in.SetRunVariableUseCase;
import com.fathy.alfred.backend.relive.application.port.in.StartRunUseCase;
import com.fathy.alfred.backend.relive.application.port.in.StopRunUseCase;
import com.fathy.alfred.backend.relive.application.port.in.UpdateRunDefinitionUseCase;
import com.fathy.alfred.backend.relive.domain.model.GlobalRulesSelection;
import com.fathy.alfred.backend.relive.domain.model.ReliveCycle;
import com.fathy.alfred.backend.relive.domain.model.ReliveSettings;
import com.fathy.alfred.backend.relive.domain.model.Run;
import com.fathy.alfred.backend.relive.domain.model.RunStatus;
import com.fathy.alfred.backend.relive.domain.model.StepResult;
import com.fathy.alfred.backend.relive.domain.model.StepState;
import com.fathy.alfred.backend.relive.domain.model.UnexpectedCallsPolicy;
import com.fathy.alfred.backend.relive.domain.model.ValidationFinding;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import java.util.List;
import java.util.Optional;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@WebMvcTest(ReliveRunsController.class)
class ReliveRunsControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @MockBean private StartRunUseCase startRun;
    @MockBean private RecordStepResultUseCase recordStepResult;
    @MockBean private StopRunUseCase stopRun;
    @MockBean private FinishRunUseCase finishRun;
    @MockBean private HoldRunUseCase holdRun;
    @MockBean private ResumeRunUseCase resumeRun;
    @MockBean private UpdateRunDefinitionUseCase updateRunDefinition;
    @MockBean private ListRunsUseCase listRuns;
    @MockBean private GetRunUseCase getRun;
    @MockBean private SetRunVariableUseCase setRunVariable;
    @MockBean private ManageReliveCyclesUseCase manageCycles;

    private ReliveCycle cycle(String id) {
        return new ReliveCycle(id, "Book flow", null, List.of(), List.of(), List.of(),
                new GlobalRulesSelection("NONE", List.of()),
                new ReliveSettings("LIVE", "HOLD", "CONTINUE", "AUTOMATIC", List.of()),
                List.of(), new UnexpectedCallsPolicy("BLOCK", List.of(), "BLOCK"), "t0", "t0", false, null);
    }

    private Run run(String id, RunStatus status) {
        return new Run(id, "c-1", "AUTOMATIC", status, "t0", null, cycle("c-1"), null,
                List.of(), List.of(), null, null, List.of(), List.of());
    }

    @Test
    void startReturns201() throws Exception {
        when(startRun.start(eq("c-1"), any())).thenReturn(run("r-1", RunStatus.RUNNING));

        mockMvc.perform(post("/relive-cycles/c-1/runs")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"driver\":\"AUTOMATIC\"}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.id").value("r-1"));
    }

    @Test
    void startReturns422WithFindingsOnBlock() throws Exception {
        when(startRun.start(eq("c-1"), any())).thenThrow(
                new RunBlockedException(List.of(new ValidationFinding("BLOCK", "MISSING_RECORDING", "s-1", "no recording"))));

        mockMvc.perform(post("/relive-cycles/c-1/runs")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{}"))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$[0].code").value("MISSING_RECORDING"));
    }

    @Test
    void listClampsLimitTo100() throws Exception {
        when(listRuns.list(eq("c-1"), anyInt())).thenReturn(List.of());

        mockMvc.perform(get("/relive-cycles/c-1/runs").param("limit", "500"))
                .andExpect(status().isOk());

        verify(listRuns).list("c-1", 100);
    }

    @Test
    void getReturnsRunDetailFlattenedWithSecrets() throws Exception {
        when(getRun.get("r-1")).thenReturn(Optional.of(new GetRunUseCase.RunDetail(run("r-1", RunStatus.RUNNING), List.of())));

        mockMvc.perform(get("/relive-cycles/c-1/runs/r-1"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id").value("r-1"))
                .andExpect(jsonPath("$.cycleId").value("c-1"))
                .andExpect(jsonPath("$.stepResults").isArray())
                .andExpect(jsonPath("$.secrets").isArray());
    }

    @Test
    void getMissingReturns404() throws Exception {
        when(getRun.get("missing")).thenReturn(Optional.empty());

        mockMvc.perform(get("/relive-cycles/c-1/runs/missing")).andExpect(status().isNotFound());
    }

    @Test
    void recordStepResultReturns200() throws Exception {
        StepResult result = new StepResult("r-1", "s-1", 1, StepState.COMPLETED, "LIVE", "HEADER", null, null, null,
                List.of(), List.of(), List.of(), List.of(), null, "t0", "t1", 5L, null, List.of(), null, List.of(), null);

        mockMvc.perform(put("/relive-cycles/c-1/runs/r-1/steps/s-1/attempts/1")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(new com.fasterxml.jackson.databind.ObjectMapper().writeValueAsString(result)))
                .andExpect(status().isOk());

        verify(recordStepResult).recordStepResult(eq("r-1"), any());
    }

    @Test
    void setVariableReturns204() throws Exception {
        mockMvc.perform(post("/relive-cycles/c-1/runs/r-1/variables")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"token\",\"value\":\"v1\"}"))
                .andExpect(status().isNoContent());
    }

    @Test
    void stopReturnsRun() throws Exception {
        when(stopRun.stop("r-1")).thenReturn(run("r-1", RunStatus.STOPPED));

        mockMvc.perform(post("/relive-cycles/c-1/runs/r-1/stop"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("STOPPED"));
    }

    @Test
    void finishReturnsRun() throws Exception {
        when(finishRun.finish("r-1", RunStatus.COMPLETED)).thenReturn(run("r-1", RunStatus.COMPLETED));

        mockMvc.perform(post("/relive-cycles/c-1/runs/r-1/finish")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"status\":\"COMPLETED\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("COMPLETED"));
    }

    @Test
    void holdReturnsRun() throws Exception {
        when(holdRun.hold(eq("r-1"), eq("s-1"), eq("FAILED"))).thenReturn(run("r-1", RunStatus.RUNNING));

        mockMvc.perform(put("/relive-cycles/c-1/runs/r-1/hold")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"stepKey\":\"s-1\",\"reason\":\"FAILED\"}"))
                .andExpect(status().isOk());
    }

    @Test
    void resumeReturns409WhenLeaseHeld() throws Exception {
        when(resumeRun.resume(eq("r-1"), any())).thenThrow(new RunLeaseHeldException("r-1"));

        mockMvc.perform(post("/relive-cycles/c-1/runs/r-1/resume")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{}"))
                .andExpect(status().isConflict());
    }

    @Test
    void updateDefinitionReturns409OnConflict() throws Exception {
        when(updateRunDefinition.updateDefinition(eq("r-1"), any(), any()))
                .thenThrow(new RunDefinitionConflictException("r-1", "s-1"));

        mockMvc.perform(put("/relive-cycles/c-1/runs/r-1/definition")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"definition\":{\"name\":\"Book flow\"}}"))
                .andExpect(status().isConflict());
    }

    @Test
    void saveEditsUpdatesTheCycle() throws Exception {
        when(manageCycles.get("c-1")).thenReturn(Optional.of(cycle("c-1")));
        when(manageCycles.update(eq("c-1"), any(), eq(null), any())).thenReturn(cycle("c-1"));

        mockMvc.perform(post("/relive-cycles/c-1/runs/r-1/steps/s-1/save-edits")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"key":"s-1","label":"label","enabled":true,"optional":false,"direction":"inbound",
                                 "unattributed":"BLOCK","callRule":{"rule":{}}}
                                """))
                .andExpect(status().isOk());
    }

    @Test
    void compareReturnsStepMatchedPairs() throws Exception {
        StepResult resultA = new StepResult("a", "s-1", 1, StepState.COMPLETED, "LIVE", "HEADER", null, null, null,
                List.of(), List.of(), List.of(), List.of(), null, "t0", "t1", 5L, null, List.of(), null, List.of(), null);
        when(getRun.get("a")).thenReturn(Optional.of(new GetRunUseCase.RunDetail(run("a", RunStatus.COMPLETED), List.of(resultA))));
        when(getRun.get("b")).thenReturn(Optional.of(new GetRunUseCase.RunDetail(run("b", RunStatus.COMPLETED), List.of())));

        mockMvc.perform(get("/relive-cycles/c-1/runs/a/compare/b"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].stepKey").value("s-1"))
                .andExpect(jsonPath("$[0].a.stepKey").value("s-1"))
                .andExpect(jsonPath("$[0].b").doesNotExist());
    }
}
