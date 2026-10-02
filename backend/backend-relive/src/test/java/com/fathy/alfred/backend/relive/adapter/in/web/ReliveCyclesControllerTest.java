package com.fathy.alfred.backend.relive.adapter.in.web;

import com.fathy.alfred.backend.relive.application.port.in.CycleInUseException;
import com.fathy.alfred.backend.relive.application.port.in.CycleValidationException;
import com.fathy.alfred.backend.relive.application.port.in.ManageCycleVersionsUseCase;
import com.fathy.alfred.backend.relive.application.port.in.ManageReliveCyclesUseCase;
import com.fathy.alfred.backend.relive.application.port.in.StaleCycleException;
import com.fathy.alfred.backend.relive.application.port.in.ValidateCycleUseCase;
import com.fathy.alfred.backend.relive.domain.model.GlobalRulesSelection;
import com.fathy.alfred.backend.relive.domain.model.ReliveCycle;
import com.fathy.alfred.backend.relive.domain.model.ReliveCycleSummary;
import com.fathy.alfred.backend.relive.domain.model.ReliveSettings;
import com.fathy.alfred.backend.relive.domain.model.UnexpectedCallsPolicy;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import java.util.List;
import java.util.Optional;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@WebMvcTest(ReliveCyclesController.class)
class ReliveCyclesControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private ManageReliveCyclesUseCase manageCycles;
    @MockBean
    private ValidateCycleUseCase validateCycle;
    @MockBean
    private ManageCycleVersionsUseCase manageVersions;

    private ReliveCycle cycle(String id) {
        return new ReliveCycle(id, "Book flow", null, List.of(), List.of(), List.of(),
                new GlobalRulesSelection("NONE", List.of()),
                new ReliveSettings("LIVE", "HOLD", "CONTINUE", "AUTOMATIC", List.of()),
                List.of(), new UnexpectedCallsPolicy("BLOCK", List.of(), "BLOCK"),
                "t0", "t0", false, null);
    }

    @Test
    void listReturnsSummariesWithoutBodies() throws Exception {
        when(manageCycles.list()).thenReturn(List.of(
                new ReliveCycleSummary("c-1", "Book flow", null, 3, 2, 1, 1, null, "t0", "t0", false)));

        mockMvc.perform(get("/relive-cycles"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].id").value("c-1"))
                .andExpect(jsonPath("$[0].stepCount").value(3));
    }

    @Test
    void createReturns201() throws Exception {
        when(manageCycles.create(any(), anyBoolean())).thenReturn(cycle("c-1"));

        mockMvc.perform(post("/relive-cycles")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"name":"Book flow"}
                                """))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.id").value("c-1"));
    }

    @Test
    void createRejectsBlankName() throws Exception {
        mockMvc.perform(post("/relive-cycles")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"name":""}
                                """))
                .andExpect(status().isBadRequest());
    }

    @Test
    void createWithInvalidRuleReturns400() throws Exception {
        when(manageCycles.create(any(), anyBoolean())).thenThrow(new CycleValidationException(List.of("bad")));

        mockMvc.perform(post("/relive-cycles")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"name":"Book flow"}
                                """))
                .andExpect(status().isBadRequest());
    }

    @Test
    void updateWithStaleIfMatchReturns409() throws Exception {
        when(manageCycles.update(eq("c-1"), any(), anyString(), isNull())).thenThrow(new StaleCycleException("c-1"));

        mockMvc.perform(put("/relive-cycles/c-1")
                        .header("If-Match", "old-timestamp")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"name":"Book flow"}
                                """))
                .andExpect(status().isConflict());
    }

    @Test
    void deleteWithRunningRunReturns409() throws Exception {
        doThrow(new CycleInUseException("c-1")).when(manageCycles).delete("c-1");

        mockMvc.perform(delete("/relive-cycles/c-1")).andExpect(status().isConflict());
    }

    @Test
    void deleteSucceedsReturns204() throws Exception {
        mockMvc.perform(delete("/relive-cycles/c-1")).andExpect(status().isNoContent());
    }

    @Test
    void getMissingReturns404() throws Exception {
        when(manageCycles.get("missing")).thenReturn(Optional.empty());
        mockMvc.perform(get("/relive-cycles/missing")).andExpect(status().isNotFound());
    }
}
