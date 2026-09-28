package com.fathy.alfred.backend.relive.adapter.in.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.relive.application.port.in.ManageReliveCyclesUseCase;
import com.fathy.alfred.backend.relive.application.port.in.UseLiveCallAsRecordingUseCase;
import com.fathy.alfred.backend.relive.application.port.out.LiveCallStorePort;
import com.fathy.alfred.backend.relive.domain.model.CycleVariable;
import com.fathy.alfred.backend.relive.domain.model.GlobalRulesSelection;
import com.fathy.alfred.backend.relive.domain.model.LiveCall;
import com.fathy.alfred.backend.relive.domain.model.ReliveCycle;
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
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@WebMvcTest(LiveCallsController.class)
class LiveCallsControllerTest {

    @Autowired
    private MockMvc mockMvc;
    @Autowired
    private ObjectMapper objectMapper;

    @MockBean private LiveCallStorePort liveCallStore;
    @MockBean private ManageReliveCyclesUseCase manageCycles;
    @MockBean private UseLiveCallAsRecordingUseCase useAsRecording;

    private ReliveCycle cycle(String id, List<CycleVariable> variables) {
        return new ReliveCycle(id, "Book flow", null, List.of(), variables, List.of(),
                new GlobalRulesSelection("NONE", List.of()),
                new ReliveSettings("LIVE", "HOLD", "CONTINUE", "AUTOMATIC", List.of()),
                List.of(), new UnexpectedCallsPolicy("BLOCK", List.of(), "BLOCK"), "t0", "t0", false, null);
    }

    private LiveCall liveCall(String id, JsonNode request, JsonNode response) {
        return new LiveCall(id, "c-1", "r-1", "s-1", "REACHED_UPSTREAM", "call-1", request, response, 200, 42L, "t0");
    }

    @Test
    void listReturnsCallsWithSizeHeader() throws Exception {
        when(liveCallStore.list(eq("c-1"), anyInt())).thenReturn(List.of(liveCall("l-1", null, null)));
        when(liveCallStore.totalBytes("c-1")).thenReturn(12345L);

        mockMvc.perform(get("/relive-cycles/c-1/live-calls"))
                .andExpect(status().isOk())
                .andExpect(header().string("X-Live-Calls-Bytes", "12345"))
                .andExpect(jsonPath("$[0].id").value("l-1"));
    }

    @Test
    void getReturnsFullCallWithSecretNames() throws Exception {
        JsonNode request = objectMapper.readTree("{\"headers\":{},\"body\":\"{}\"}");
        when(liveCallStore.findById("l-1")).thenReturn(Optional.of(liveCall("l-1", request, request)));
        when(manageCycles.get("c-1")).thenReturn(Optional.of(cycle("c-1", List.of(new CycleVariable("token", "abc", true, null)))));

        mockMvc.perform(get("/relive-cycles/c-1/live-calls/l-1"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id").value("l-1"))
                .andExpect(jsonPath("$.secrets[0]").value("token"));
    }

    @Test
    void getMissingReturns404() throws Exception {
        when(liveCallStore.findById("missing")).thenReturn(Optional.empty());

        mockMvc.perform(get("/relive-cycles/c-1/live-calls/missing")).andExpect(status().isNotFound());
    }

    @Test
    void deleteReturns204WhenFound() throws Exception {
        when(liveCallStore.deleteById("l-1")).thenReturn(true);

        mockMvc.perform(delete("/relive-cycles/c-1/live-calls/l-1")).andExpect(status().isNoContent());
    }

    @Test
    void deleteReturns404WhenNotFound() throws Exception {
        when(liveCallStore.deleteById("missing")).thenReturn(false);

        mockMvc.perform(delete("/relive-cycles/c-1/live-calls/missing")).andExpect(status().isNotFound());
    }

    @Test
    void useAsRecordingDelegatesToTheUseCase() throws Exception {
        when(useAsRecording.useAsRecording("c-1", "l-1", "s-1")).thenReturn(cycle("c-1", List.of()));

        mockMvc.perform(post("/relive-cycles/c-1/live-calls/l-1/use-as-recording")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"stepKey\":\"s-1\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id").value("c-1"));

        verify(useAsRecording).useAsRecording("c-1", "l-1", "s-1");
    }

    @Test
    void useAsRecordingMissingReturns404() throws Exception {
        when(useAsRecording.useAsRecording(any(), any(), any())).thenThrow(new IllegalArgumentException("no such step"));

        mockMvc.perform(post("/relive-cycles/c-1/live-calls/l-1/use-as-recording")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"stepKey\":\"missing\"}"))
                .andExpect(status().isNotFound());
    }
}
