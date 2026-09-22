package com.fathy.alfred.backend.sessioncycles.adapter.in.web;

import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ClearCapturedCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.CopyCallsToCycleUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.CopyInternalCallsToCycleUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.CreateCycleSpacerUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.CreateSessionCycleUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.DeleteCycleSpacerUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.DeleteSessionCycleUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.GetCapturedCallDetailUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.GetCapturedInternalCallDetailUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.GetSessionCycleUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListCallOverlapsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListCapturedCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListCapturedInternalCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListCycleSpacersUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListSessionCyclesUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.MoveCycleSpacerUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.PauseRecordingUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.RemoveCapturedCallUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.RemoveCapturedCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.RemoveCapturedInternalCallUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.RemoveCapturedInternalCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.RenameCycleSpacerUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.StartRecordingUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.UpdateSessionCycleUseCase;
import com.fathy.alfred.backend.sessioncycles.domain.model.CallOverlapEntry;
import com.fathy.alfred.backend.sessioncycles.domain.model.CallOverlapQuery;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedCallsPage;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedInternalCallsPage;
import com.fathy.alfred.backend.sessioncycles.domain.model.CopyCallsResult;
import com.fathy.alfred.backend.sessioncycles.domain.model.CycleSpacer;
import com.fathy.alfred.backend.sessioncycles.domain.model.DeleteOutcome;
import com.fathy.alfred.backend.sessioncycles.domain.model.NewSessionCycle;
import com.fathy.alfred.backend.sessioncycles.domain.model.RemoveCallsResult;
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
    private GetCapturedCallDetailUseCase getCapturedCallDetailUseCase;
    @MockBean
    private RemoveCapturedCallUseCase removeCapturedCallUseCase;
    @MockBean
    private RemoveCapturedCallsUseCase removeCapturedCallsUseCase;
    @MockBean
    private ClearCapturedCallsUseCase clearCapturedCallsUseCase;
    @MockBean
    private CopyCallsToCycleUseCase copyCallsToCycleUseCase;
    @MockBean
    private ListCapturedInternalCallsUseCase listCapturedInternalCallsUseCase;
    @MockBean
    private GetCapturedInternalCallDetailUseCase getCapturedInternalCallDetailUseCase;
    @MockBean
    private RemoveCapturedInternalCallUseCase removeCapturedInternalCallUseCase;
    @MockBean
    private RemoveCapturedInternalCallsUseCase removeCapturedInternalCallsUseCase;
    @MockBean
    private CopyInternalCallsToCycleUseCase copyInternalCallsToCycleUseCase;
    @MockBean
    private ListCallOverlapsUseCase listCallOverlapsUseCase;
    @MockBean
    private ListCycleSpacersUseCase listCycleSpacersUseCase;
    @MockBean
    private CreateCycleSpacerUseCase createCycleSpacerUseCase;
    @MockBean
    private RenameCycleSpacerUseCase renameCycleSpacerUseCase;
    @MockBean
    private MoveCycleSpacerUseCase moveCycleSpacerUseCase;
    @MockBean
    private DeleteCycleSpacerUseCase deleteCycleSpacerUseCase;

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
    void getDetailReturnsTheRequestAndResponse() throws Exception {
        CallRecord call = new CallRecord("call-1", "https://a.com-proxy/x", "https://a.com/x", "GET",
                new com.fathy.alfred.backend.calls.domain.model.RequestData(java.util.Map.of(), "req-body"), "t",
                1.0, new com.fathy.alfred.backend.calls.domain.model.ResponseData(200, java.util.Map.of(), "resp-body"), null);
        when(getCapturedCallDetailUseCase.getDetail("c1", "call-1"))
                .thenReturn(Optional.of(com.fathy.alfred.backend.calls.domain.model.CallDetail.of(call)));

        mockMvc.perform(get("/session-cycles/c1/calls/call-1/detail"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.request.body").value("req-body"))
                .andExpect(jsonPath("$.response.body").value("resp-body"));
    }

    @Test
    void getDetailReturnsNotFoundWhenMissing() throws Exception {
        when(getCapturedCallDetailUseCase.getDetail("c1", "missing")).thenReturn(Optional.empty());

        mockMvc.perform(get("/session-cycles/c1/calls/missing/detail")).andExpect(status().isNotFound());
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
    void clearCallsSucceedsWhenTheCycleExists() throws Exception {
        when(clearCapturedCallsUseCase.clearCalls("c1")).thenReturn(true);

        mockMvc.perform(post("/session-cycles/c1/calls/clear")).andExpect(status().isNoContent());
    }

    @Test
    void clearCallsReturnsNotFoundWhenTheCycleIsMissing() throws Exception {
        when(clearCapturedCallsUseCase.clearCalls("missing")).thenReturn(false);

        mockMvc.perform(post("/session-cycles/missing/calls/clear")).andExpect(status().isNotFound());
    }

    @Test
    void removeCallsRejectsAnEmptyCallIdsList() throws Exception {
        mockMvc.perform(post("/session-cycles/c1/calls/remove")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"callIds":[]}
                                """))
                .andExpect(status().isBadRequest());
    }

    @Test
    void removeCallsReturnsNotFoundWhenTheCycleDoesNotExist() throws Exception {
        when(removeCapturedCallsUseCase.removeCalls(eq("missing"), any())).thenReturn(Optional.empty());

        mockMvc.perform(post("/session-cycles/missing/calls/remove")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"callIds":["call-1"]}
                                """))
                .andExpect(status().isNotFound());
    }

    @Test
    void removeCallsReturnsTheRemovedAndNotFoundCounts() throws Exception {
        when(removeCapturedCallsUseCase.removeCalls(eq("c1"), any())).thenReturn(Optional.of(new RemoveCallsResult(2, 1)));

        mockMvc.perform(post("/session-cycles/c1/calls/remove")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"callIds":["call-1","call-2","missing"]}
                                """))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.removed").value(2))
                .andExpect(jsonPath("$.notFound").value(1));

        verify(removeCapturedCallsUseCase).removeCalls(eq("c1"), eq(List.of("call-1", "call-2", "missing")));
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

    @Test
    void copyInternalCallsRejectsAnEmptyCallsList() throws Exception {
        mockMvc.perform(post("/session-cycles/c1/internal-calls/copy")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"calls":[]}
                                """))
                .andExpect(status().isBadRequest());
    }

    @Test
    void copyInternalCallsReturnsNotFoundWhenTheCycleDoesNotExist() throws Exception {
        when(copyInternalCallsToCycleUseCase.copyInto(eq("missing"), any())).thenReturn(Optional.empty());

        mockMvc.perform(post("/session-cycles/missing/internal-calls/copy")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"calls":[{"original_url":"http://host.docker.internal:8081/x","url":"http://host.docker.internal:8081/x","method":"GET","timestamp":"t1"}]}
                                """))
                .andExpect(status().isNotFound());
    }

    @Test
    void copyInternalCallsReturnsTheAddedAndSkippedCounts() throws Exception {
        when(copyInternalCallsToCycleUseCase.copyInto(eq("c1"), any())).thenReturn(Optional.of(new CopyCallsResult(1, 1)));

        mockMvc.perform(post("/session-cycles/c1/internal-calls/copy")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"calls":[
                                  {"original_url":"http://host.docker.internal:8081/a","url":"http://host.docker.internal:8081/a","method":"GET","timestamp":"t1"},
                                  {"original_url":"http://host.docker.internal:8081/b","url":"http://host.docker.internal:8081/b","method":"POST","timestamp":"t2"}
                                ]}
                                """))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.added").value(1))
                .andExpect(jsonPath("$.skipped").value(1));

        verify(copyInternalCallsToCycleUseCase).copyInto(eq("c1"), org.mockito.ArgumentMatchers.argThat(calls -> calls.size() == 2));
    }

    @Test
    void listInternalCallsReturnsNotFoundWhenTheCycleDoesNotExist() throws Exception {
        when(listCapturedInternalCallsUseCase.listCalls(eq("missing"), any())).thenReturn(Optional.empty());

        mockMvc.perform(get("/session-cycles/missing/internal-calls")).andExpect(status().isNotFound());
    }

    @Test
    void listInternalCallsReturnsTheCapturedCalls() throws Exception {
        when(listCapturedInternalCallsUseCase.listCalls(eq("c1"), any())).thenReturn(Optional.of(new CapturedInternalCallsPage(List.of(), 0)));

        mockMvc.perform(get("/session-cycles/c1/internal-calls")).andExpect(status().isOk());
    }

    @Test
    void getInternalCallDetailReturnsTheRequestAndResponse() throws Exception {
        com.fathy.alfred.backend.internalcalls.domain.model.CallRecord call = new com.fathy.alfred.backend.internalcalls.domain.model.CallRecord(
                "call-1", "https://wildfly-proxy/x", "https://wildfly/x", "GET",
                new com.fathy.alfred.backend.internalcalls.domain.model.RequestData(java.util.Map.of(), "req-body"), "t",
                1.0, new com.fathy.alfred.backend.internalcalls.domain.model.ResponseData(200, java.util.Map.of(), "resp-body"), null);
        when(getCapturedInternalCallDetailUseCase.getDetail("c1", "call-1"))
                .thenReturn(Optional.of(com.fathy.alfred.backend.internalcalls.domain.model.CallDetail.of(call)));

        mockMvc.perform(get("/session-cycles/c1/internal-calls/call-1/detail"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.request.body").value("req-body"))
                .andExpect(jsonPath("$.response.body").value("resp-body"));
    }

    @Test
    void getInternalCallDetailReturnsNotFoundWhenMissing() throws Exception {
        when(getCapturedInternalCallDetailUseCase.getDetail("c1", "missing")).thenReturn(Optional.empty());

        mockMvc.perform(get("/session-cycles/c1/internal-calls/missing/detail")).andExpect(status().isNotFound());
    }

    @Test
    void removeInternalCallReturnsNoContentOnSuccess() throws Exception {
        when(removeCapturedInternalCallUseCase.removeCall("c1", "call-1")).thenReturn(true);

        mockMvc.perform(delete("/session-cycles/c1/internal-calls/call-1")).andExpect(status().isNoContent());
    }

    @Test
    void removeInternalCallReturnsNotFoundWhenMissing() throws Exception {
        when(removeCapturedInternalCallUseCase.removeCall("c1", "missing")).thenReturn(false);

        mockMvc.perform(delete("/session-cycles/c1/internal-calls/missing")).andExpect(status().isNotFound());
    }

    @Test
    void removeInternalCallsReturnsTheRemovedAndNotFoundCounts() throws Exception {
        when(removeCapturedInternalCallsUseCase.removeCalls(eq("c1"), any())).thenReturn(Optional.of(new RemoveCallsResult(2, 1)));

        mockMvc.perform(post("/session-cycles/c1/internal-calls/remove")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"callIds":["call-1","call-2","missing"]}
                                """))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.removed").value(2))
                .andExpect(jsonPath("$.notFound").value(1));
    }

    @Test
    void listCallOverlapsReturnsTheUseCasesMergedList() throws Exception {
        CallOverlapEntry entry = new CallOverlapEntry("call-1", "external", null, "2024-01-01T00:00:00Z", 12.5, 200, null);
        when(listCallOverlapsUseCase.listCallOverlaps(eq("c1"), any())).thenReturn(Optional.of(List.of(entry)));

        mockMvc.perform(get("/session-cycles/c1/call-overlaps")
                        .param("from", "2024-01-01T00:00:00Z")
                        .param("to", "2024-01-01T00:00:05Z"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].id").value("call-1"))
                .andExpect(jsonPath("$[0].source").value("external"));
    }

    @Test
    void listCallOverlapsParsesTheRequiredFromAndToParams() throws Exception {
        when(listCallOverlapsUseCase.listCallOverlaps(eq("c1"), any())).thenReturn(Optional.of(List.of()));

        mockMvc.perform(get("/session-cycles/c1/call-overlaps")
                        .param("from", "2024-01-01T00:00:00Z")
                        .param("to", "2024-01-01T00:00:05Z"))
                .andExpect(status().isOk());

        verify(listCallOverlapsUseCase).listCallOverlaps("c1", new CallOverlapQuery(
                java.time.Instant.parse("2024-01-01T00:00:00Z"), java.time.Instant.parse("2024-01-01T00:00:05Z"),
                "", "", "", "", "", ""));
    }

    @Test
    void listCallOverlapsReturnsNotFoundWhenTheCycleIsMissing() throws Exception {
        when(listCallOverlapsUseCase.listCallOverlaps(eq("missing"), any())).thenReturn(Optional.empty());

        mockMvc.perform(get("/session-cycles/missing/call-overlaps")
                        .param("from", "2024-01-01T00:00:00Z")
                        .param("to", "2024-01-01T00:00:05Z"))
                .andExpect(status().isNotFound());
    }

    @Test
    void listCallOverlapsRejectsAnUnparseableFromTimestampWithBadRequest() throws Exception {
        mockMvc.perform(get("/session-cycles/c1/call-overlaps")
                        .param("from", "not-a-timestamp")
                        .param("to", "2024-01-01T00:00:05Z"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void listSpacersReturnsNotFoundWhenTheCycleIsMissing() throws Exception {
        when(listCycleSpacersUseCase.listSpacers("missing")).thenReturn(Optional.empty());

        mockMvc.perform(get("/session-cycles/missing/spacers")).andExpect(status().isNotFound());
    }

    @Test
    void listSpacersReturnsEverySpacerForTheCycle() throws Exception {
        CycleSpacer spacer = new CycleSpacer("s1", "c1", "Checkout retry attempt", "call-1", "2026-01-01T00:00:00Z");
        when(listCycleSpacersUseCase.listSpacers("c1")).thenReturn(Optional.of(List.of(spacer)));

        mockMvc.perform(get("/session-cycles/c1/spacers"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].id").value("s1"))
                .andExpect(jsonPath("$[0].label").value("Checkout retry attempt"))
                .andExpect(jsonPath("$[0].beforeCallId").value("call-1"));
    }

    @Test
    void createSpacerRejectsABlankLabel() throws Exception {
        mockMvc.perform(post("/session-cycles/c1/spacers")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"label":""}
                                """))
                .andExpect(status().isBadRequest());
    }

    @Test
    void createSpacerReturnsNotFoundWhenTheCycleIsMissing() throws Exception {
        when(createCycleSpacerUseCase.createSpacer("missing", "Retry attempt", "call-1")).thenReturn(Optional.empty());

        mockMvc.perform(post("/session-cycles/missing/spacers")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"label":"Retry attempt","beforeCallId":"call-1"}
                                """))
                .andExpect(status().isNotFound());
    }

    @Test
    void createSpacerReturns201WithTheCreatedSpacer() throws Exception {
        CycleSpacer created = new CycleSpacer("s1", "c1", "Retry attempt", "call-1", "2026-01-01T00:00:00Z");
        when(createCycleSpacerUseCase.createSpacer("c1", "Retry attempt", "call-1")).thenReturn(Optional.of(created));

        mockMvc.perform(post("/session-cycles/c1/spacers")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"label":"Retry attempt","beforeCallId":"call-1"}
                                """))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.id").value("s1"));
    }

    @Test
    void createSpacerAcceptsANullBeforeCallIdMeaningAfterEveryCall() throws Exception {
        CycleSpacer created = new CycleSpacer("s1", "c1", "Retry attempt", null, "2026-01-01T00:00:00Z");
        when(createCycleSpacerUseCase.createSpacer("c1", "Retry attempt", null)).thenReturn(Optional.of(created));

        mockMvc.perform(post("/session-cycles/c1/spacers")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"label":"Retry attempt"}
                                """))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.beforeCallId").doesNotExist());
    }

    @Test
    void renameSpacerReturnsNotFoundWhenMissing() throws Exception {
        when(renameCycleSpacerUseCase.renameSpacer("c1", "missing", "New label")).thenReturn(Optional.empty());

        mockMvc.perform(patch("/session-cycles/c1/spacers/missing")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"label":"New label"}
                                """))
                .andExpect(status().isNotFound());
    }

    @Test
    void renameSpacerReturnsTheUpdatedSpacer() throws Exception {
        CycleSpacer renamed = new CycleSpacer("s1", "c1", "New label", "call-1", "2026-01-01T00:00:00Z");
        when(renameCycleSpacerUseCase.renameSpacer("c1", "s1", "New label")).thenReturn(Optional.of(renamed));

        mockMvc.perform(patch("/session-cycles/c1/spacers/s1")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"label":"New label"}
                                """))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.label").value("New label"));
    }

    @Test
    void moveSpacerReturnsNotFoundWhenMissing() throws Exception {
        when(moveCycleSpacerUseCase.moveSpacer("c1", "missing", "call-2")).thenReturn(Optional.empty());

        mockMvc.perform(patch("/session-cycles/c1/spacers/missing/move")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"beforeCallId":"call-2"}
                                """))
                .andExpect(status().isNotFound());
    }

    @Test
    void moveSpacerReturnsTheReanchoredSpacer() throws Exception {
        CycleSpacer moved = new CycleSpacer("s1", "c1", "Retry attempt", "call-2", "2026-01-01T00:00:00Z");
        when(moveCycleSpacerUseCase.moveSpacer("c1", "s1", "call-2")).thenReturn(Optional.of(moved));

        mockMvc.perform(patch("/session-cycles/c1/spacers/s1/move")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"beforeCallId":"call-2"}
                                """))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.beforeCallId").value("call-2"));
    }

    @Test
    void deleteSpacerReturnsNoContentOnSuccess() throws Exception {
        when(deleteCycleSpacerUseCase.deleteSpacer("c1", "s1")).thenReturn(true);

        mockMvc.perform(delete("/session-cycles/c1/spacers/s1")).andExpect(status().isNoContent());
    }

    @Test
    void deleteSpacerReturnsNotFoundWhenMissing() throws Exception {
        when(deleteCycleSpacerUseCase.deleteSpacer("c1", "missing")).thenReturn(false);

        mockMvc.perform(delete("/session-cycles/c1/spacers/missing")).andExpect(status().isNotFound());
    }
}
