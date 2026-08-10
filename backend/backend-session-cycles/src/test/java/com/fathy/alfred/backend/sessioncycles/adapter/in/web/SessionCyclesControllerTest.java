package com.fathy.alfred.backend.sessioncycles.adapter.in.web;

import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import com.fathy.alfred.backend.sessioncycles.application.port.in.CopyCallsToCycleUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.CreateSessionCycleUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.DeleteSessionCycleUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.GetSessionCycleUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListCapturedCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListSessionCyclesUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.PauseRecordingUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.RemoveCapturedCallUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.StartRecordingUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.UpdateSessionCycleUseCase;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedCallsPage;
import com.fathy.alfred.backend.sessioncycles.domain.model.CopyCallsResult;
import com.fathy.alfred.backend.sessioncycles.domain.model.DeleteOutcome;
import com.fathy.alfred.backend.sessioncycles.domain.model.NewSessionCycle;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycleStatus;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycleUpdate;
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
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@WebMvcTest(SessionCyclesController.class)
class SessionCyclesControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private CreateSessionCycleUseCase createSessionCycleUseCase;
    @MockBean
    private ListSessionCyclesUseCase listSessionCyclesUseCase;
    @MockBean
    private GetSessionCycleUseCase getSessionCycleUseCase;
    @MockBean
    private UpdateSessionCycleUseCase updateSessionCycleUseCase;
    @MockBean
    private StartRecordingUseCase startRecordingUseCase;
    @MockBean
    private PauseRecordingUseCase pauseRecordingUseCase;
    @MockBean
    private DeleteSessionCycleUseCase deleteSessionCycleUseCase;
    @MockBean
    private ListCapturedCallsUseCase listCapturedCallsUseCase;
    @MockBean
    private RemoveCapturedCallUseCase removeCapturedCallUseCase;
    @MockBean
    private CopyCallsToCycleUseCase copyCallsToCycleUseCase;

    private static SessionCycle cycle(String id, SessionCycleStatus status) {
        return new SessionCycle(id, "Repro", "2026-01-01T00:00:00Z", null, status);
    }

    @Test
    void rejectsACreateRequestWithABlankName() throws Exception {
        mockMvc.perform(post("/session-cycles")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"name":""}
                                """))
                .andExpect(status().isBadRequest());
    }

    @Test
    void createsACycleAndReturns201() throws Exception {
        when(createSessionCycleUseCase.create(any())).thenReturn(cycle("c1", SessionCycleStatus.PAUSED));

        mockMvc.perform(post("/session-cycles")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"name":"Repro flight bug","assignedTo":"profile-1"}
                                """))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.id").value("c1"));

        verify(createSessionCycleUseCase).create(new NewSessionCycle("Repro flight bug", "profile-1"));
    }

    @Test
    void listReturnsEveryCycle() throws Exception {
        when(listSessionCyclesUseCase.listAll()).thenReturn(List.of(cycle("c1", SessionCycleStatus.PAUSED)));

        mockMvc.perform(get("/session-cycles"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].id").value("c1"));
    }

    @Test
    void getReturnsNotFoundWhenMissing() throws Exception {
        when(getSessionCycleUseCase.getById("missing")).thenReturn(Optional.empty());

        mockMvc.perform(get("/session-cycles/missing")).andExpect(status().isNotFound());
    }

    @Test
    void patchUpdatesAndReturnsTheCycle() throws Exception {
        when(updateSessionCycleUseCase.update(eq("c1"), any())).thenReturn(Optional.of(cycle("c1", SessionCycleStatus.PAUSED)));

        mockMvc.perform(patch("/session-cycles/c1")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"name":"Renamed"}
                                """))
                .andExpect(status().isOk());

        verify(updateSessionCycleUseCase).update("c1", new SessionCycleUpdate("Renamed", null));
    }

    @Test
    void recordReturnsNotFoundWhenMissing() throws Exception {
        when(startRecordingUseCase.startRecording("missing")).thenReturn(Optional.empty());

        mockMvc.perform(post("/session-cycles/missing/record")).andExpect(status().isNotFound());
    }

    @Test
    void recordReturnsTheUpdatedCycle() throws Exception {
        when(startRecordingUseCase.startRecording("c1")).thenReturn(Optional.of(cycle("c1", SessionCycleStatus.RECORDING)));

        mockMvc.perform(post("/session-cycles/c1/record"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("RECORDING"));
    }

    @Test
    void pauseReturnsTheUpdatedCycle() throws Exception {
        when(pauseRecordingUseCase.pauseRecording("c1")).thenReturn(Optional.of(cycle("c1", SessionCycleStatus.PAUSED)));

        mockMvc.perform(post("/session-cycles/c1/pause"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("PAUSED"));
    }

    @Test
    void deleteReturnsNoContentOnSuccess() throws Exception {
        when(deleteSessionCycleUseCase.delete("c1")).thenReturn(DeleteOutcome.DELETED);

        mockMvc.perform(delete("/session-cycles/c1")).andExpect(status().isNoContent());
    }

    @Test
    void deleteReturnsNotFoundWhenMissing() throws Exception {
        when(deleteSessionCycleUseCase.delete("missing")).thenReturn(DeleteOutcome.NOT_FOUND);

        mockMvc.perform(delete("/session-cycles/missing")).andExpect(status().isNotFound());
    }

    @Test
    void deleteReturnsConflictWhileRecording() throws Exception {
        when(deleteSessionCycleUseCase.delete("c1")).thenReturn(DeleteOutcome.BLOCKED_RECORDING);

        mockMvc.perform(delete("/session-cycles/c1")).andExpect(status().isConflict());
    }

    @Test
    void listCallsReturnsNotFoundWhenTheCycleDoesNotExist() throws Exception {
        when(listCapturedCallsUseCase.listCalls(eq("missing"), any())).thenReturn(Optional.empty());

        mockMvc.perform(get("/session-cycles/missing/calls")).andExpect(status().isNotFound());
    }

    @Test
    void listCallsReturnsTheCapturedCalls() throws Exception {
        when(listCapturedCallsUseCase.listCalls(eq("c1"), any())).thenReturn(Optional.of(new CapturedCallsPage(List.of(), 0)));

        mockMvc.perform(get("/session-cycles/c1/calls")).andExpect(status().isOk());
    }

    @Test
    void removeCallReturnsNoContentOnSuccess() throws Exception {
        when(removeCapturedCallUseCase.removeCall("c1", "call-1")).thenReturn(true);

        mockMvc.perform(delete("/session-cycles/c1/calls/call-1")).andExpect(status().isNoContent());
    }

    @Test
    void removeCallReturnsNotFoundWhenMissing() throws Exception {
        when(removeCapturedCallUseCase.removeCall("c1", "missing")).thenReturn(false);

        mockMvc.perform(delete("/session-cycles/c1/calls/missing")).andExpect(status().isNotFound());
    }

    @Test
    void copyCallsRejectsAnEmptyCallsList() throws Exception {
        mockMvc.perform(post("/session-cycles/c1/calls/copy")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"calls":[]}
                                """))
                .andExpect(status().isBadRequest());
    }

    @Test
    void copyCallsReturnsNotFoundWhenTheCycleDoesNotExist() throws Exception {
        when(copyCallsToCycleUseCase.copyInto(eq("missing"), any())).thenReturn(Optional.empty());

        mockMvc.perform(post("/session-cycles/missing/calls/copy")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"calls":[{"original_url":"https://a.com-proxy/x","url":"https://a.com/x","method":"GET","timestamp":"t1"}]}
                                """))
                .andExpect(status().isNotFound());
    }

    @Test
    void copyCallsReturnsTheAddedAndSkippedCounts() throws Exception {
        when(copyCallsToCycleUseCase.copyInto(eq("c1"), any())).thenReturn(Optional.of(new CopyCallsResult(1, 1)));

        mockMvc.perform(post("/session-cycles/c1/calls/copy")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"calls":[
                                  {"original_url":"https://a.com-proxy/x","url":"https://a.com/x","method":"GET","timestamp":"t1"},
                                  {"original_url":"https://b.com-proxy/x","url":"https://b.com/x","method":"POST","timestamp":"t2"}
                                ]}
                                """))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.added").value(1))
                .andExpect(jsonPath("$.skipped").value(1));

        verify(copyCallsToCycleUseCase).copyInto(eq("c1"), org.mockito.ArgumentMatchers.argThat(calls ->
                calls.size() == 2
                        && ((List<CallRecord>) calls).get(0).method().equals("GET")
                        && ((List<CallRecord>) calls).get(1).method().equals("POST")
        ));
    }
}
