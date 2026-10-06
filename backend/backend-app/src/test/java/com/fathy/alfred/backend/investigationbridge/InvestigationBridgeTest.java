package com.fathy.alfred.backend.investigationbridge;

import com.fathy.alfred.backend.dbcapture.application.port.in.CallLogLinesUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.ManageDbCaptureUseCase;
import com.fathy.alfred.backend.dbcapture.domain.model.CaughtLogLine;
import com.fathy.alfred.backend.dbcapture.domain.model.LogProblem;
import com.fathy.alfred.backend.dbcapture.domain.model.LogSearchPage;
import com.fathy.alfred.backend.dbcapture.domain.model.ProjectCaptureStatus;
import com.fathy.alfred.backend.internalcalls.domain.model.CallSummary;
import com.fathy.alfred.backend.internalcalls.domain.model.CallsPage;
import com.fathy.alfred.backend.investigationbridge.InvestigationModels.ResolvedScope;
import com.fathy.alfred.backend.investigationbridge.InvestigationModels.ScopeDto;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListCapturedCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListPagedCapturedInternalCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListSessionCyclesUseCase;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedInternalCallSummary;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedInternalCallsPage;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;
import com.fathy.alfred.backend.triage.application.port.in.AnalyseCallsUseCase;
import com.fathy.alfred.backend.triage.domain.model.CallAttention;
import com.fathy.alfred.backend.triage.domain.model.CallDirection;
import com.fathy.alfred.backend.triage.domain.model.CallSignals;
import com.fathy.alfred.backend.triage.domain.model.ProblemCall;
import com.fathy.alfred.backend.triage.domain.model.ProblemCallsPage;
import com.fathy.alfred.backend.triage.domain.model.Signal;
import com.tngtech.archunit.core.domain.JavaClasses;
import com.tngtech.archunit.core.importer.ClassFileImporter;
import com.tngtech.archunit.core.importer.ImportOption;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Optional;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** Scopes and the cross-call investigation endpoints (specs/010-mcp-log-investigation). */
class InvestigationBridgeTest {

    private final com.fathy.alfred.backend.internalcalls.application.port.in.GetCallsUseCase live =
            mock(com.fathy.alfred.backend.internalcalls.application.port.in.GetCallsUseCase.class);
    private final ListSessionCyclesUseCase cycles = mock(ListSessionCyclesUseCase.class);
    private final ListPagedCapturedInternalCallsUseCase cycleCalls = mock(ListPagedCapturedInternalCallsUseCase.class);
    private final ManageDbCaptureUseCase capture = mock(ManageDbCaptureUseCase.class);
    private final ScopeResolver resolver = new ScopeResolver(live, cycles, mock(ListCapturedCallsUseCase.class), cycleCalls, capture);
    private final AnalyseCallsUseCase analysis = mock(AnalyseCallsUseCase.class);
    private final CallLogLinesUseCase logs = mock(CallLogLinesUseCase.class);
    private final MockMvc mvc = MockMvcBuilders.standaloneSetup(new InvestigationController(new InvestigationService(resolver, analysis, logs))).build();

    private static CallSummary summary(String id, String project, String at) {
        return new CallSummary(id, "http://localhost:8080/odeysysadmin/Booking2/search?x=" + id, "http://h:9001/odeysysadmin/Booking2/search",
                "POST", at, 120.0, 200, null, null, null, null, null, project);
    }

    private static SessionCycle cycle(String id, String name) {
        return new SessionCycle(id, name, "2026-10-06T00:00:00Z", null, null);
    }

    private void seed() {
        when(live.getCalls(any())).thenReturn(new CallsPage(List.of(summary("a", "odeysys", "2026-10-06T10:00:00Z"),
                summary("b", "odeysys", "2026-10-06T10:05:00Z")), 2));
        when(cycles.listAll()).thenReturn(List.of(cycle("cy1", "impo"), cycle("cy2", "other")));
        when(cycleCalls.listCalls(eq("cy1"), any(), anyBoolean())).thenReturn(Optional.of(new CapturedInternalCallsPage(List.of(
                new CapturedInternalCallSummary("cap-a", "x", summary("a", "odeysys", "2026-10-06T10:00:00Z")),
                new CapturedInternalCallSummary("cap-c", "x", summary("c", "core-service", "2026-10-06T09:00:00Z"))), 2)));
        when(cycleCalls.listCalls(eq("cy2"), any(), anyBoolean())).thenReturn(Optional.of(new CapturedInternalCallsPage(List.of(), 0)));
        when(capture.projects()).thenReturn(List.of(new ProjectCaptureStatus("odeysys", true, true, true, null, true),
                new ProjectCaptureStatus("core-service", false, true, false, null, false)));
    }

    @Test
    void aCallLiveAndInACycleCountsOnceWithBothPlacesAndMissingDataIsNamed() {
        seed();
        ResolvedScope all = resolver.resolve(new ScopeDto("all", null, null), null, null, null);
        assertThat(all.ids()).containsExactly("a", "b", "c");
        assertThat(all.calls().get("a").heldIn()).containsExactly("live", "cycle:impo");
        assertThat(all.calls().get("a").path()).isEqualTo("/odeysysadmin/Booking2/search?x=a");
        assertThat(all.unavailable()).extracting(u -> u.project() + ":" + u.why()).containsExactly("core-service:LOGS_OFF", "core-service:DB_OFF");

        assertThat(resolver.resolve(new ScopeDto("cycles", List.of("cy1"), false), null, null, null).ids()).containsExactly("a", "c");
        assertThat(resolver.resolve(new ScopeDto("cycles", List.of("cy1"), true), "odeysys", null, null).ids()).containsExactly("a", "b");
        assertThat(resolver.resolve(null, null, "2026-10-06T10:01:00Z", null).ids()).containsExactly("b");
        assertThatThrownBy(() -> resolver.resolve(new ScopeDto("cycles", List.of("nope"), false), null, null, null))
                .isInstanceOf(NoSuchElementException.class).hasMessageContaining("nope");
        assertThatThrownBy(() -> resolver.resolve(null, null, "yesterday", null)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void problemCallsAnswerWithCountsSignalsEvidenceAndWhereEachCallIsHeld() throws Exception {
        seed();
        CallAttention mark = new CallAttention("a", CallDirection.INBOUND, "odeysys", null, "POST", "http://h/x", 200, null, 1_790_000_000_000L, 50.0,
                "COMPLETED", null, List.of(), 0, 1, 1, 4, new CallSignals(2, 1, 1, "CAUGHT", "WARN", List.of("SLOW")));
        Map<Signal, Integer> counts = new EnumMap<>(Signal.class);
        counts.put(Signal.LOG_ERROR, 1);
        when(analysis.problemCalls(any(), any(), eq(0), eq(50))).thenReturn(new ProblemCallsPage(counts, 2, 1,
                List.of(new ProblemCall(mark, List.of(Signal.DB_FAILED, Signal.LOG_ERROR), "error")), null));

        mvc.perform(post("/triage/problem-calls").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"scope\":{\"kind\":\"all\"},\"all\":[\"log_error\"]}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.counts.LOG_ERROR").value(1))
                .andExpect(jsonPath("$.counts.total").value(2))
                .andExpect(jsonPath("$.unmarked").value(1))
                .andExpect(jsonPath("$.calls[0].heldIn[1]").value("cycle:impo"))
                .andExpect(jsonPath("$.calls[0].evidence.swallowed").value(true))
                .andExpect(jsonPath("$.calls[0].evidence.dbFlags[0]").value("SLOW"))
                .andExpect(jsonPath("$.scope.calls").value(3));

        mvc.perform(post("/triage/problem-calls").contentType(MediaType.APPLICATION_JSON).content("{\"all\":[\"LOUD\"]}"))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.error").exists());
        mvc.perform(post("/triage/problem-calls").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"scope\":{\"kind\":\"cycles\",\"cycleIds\":[\"missing\"]}}"))
                .andExpect(status().isNotFound());
        mvc.perform(post("/triage/problem-calls").contentType(MediaType.APPLICATION_JSON).content("{\"scope\":{\"kind\":\"galaxy\"}}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void searchHitsCarryTheirCallAndOffsetAndProblemsTheirEndpoints() throws Exception {
        seed();
        CaughtLogLine line = new CaughtLogLine(812, "b", 14, "2026-10-06T10:05:00.839Z", "ERROR", "MainLogger", "default task-4",
                "No enum constant", "java.lang.IllegalArgumentException", "bad", "stack", false, "odeysys");
        when(logs.search(any(), any())).thenReturn(new LogSearchPage(1, List.of(line), null, null));
        mvc.perform(post("/call-logs/search").contentType(MediaType.APPLICATION_JSON).content("{\"text\":\"No enum\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.total").value(1))
                .andExpect(jsonPath("$.hits[0].path").value("/odeysysadmin/Booking2/search?x=b"))
                .andExpect(jsonPath("$.hits[0].line.lineId").value("c:812"))
                .andExpect(jsonPath("$.hits[0].line.offsetMs").value(839))
                .andExpect(jsonPath("$.hits[0].line.exception.type").value("java.lang.IllegalArgumentException"));
        mvc.perform(post("/call-logs/search").contentType(MediaType.APPLICATION_JSON).content("{}"))
                .andExpect(status().isBadRequest());

        when(logs.problems(any(), eq(false), any(), any(), anyInt())).thenReturn(new CallLogLinesUseCase.LogProblemsPage(List.of(
                new LogProblem("9f2c4a7be01d3344", line, 40, 2, 1_790_000_000_000L, 1_790_000_100_000L, List.of("a", "b"))), 1));
        mvc.perform(post("/call-logs/problems").contentType(MediaType.APPLICATION_JSON).content("{}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.problems[0].lines").value(40))
                .andExpect(jsonPath("$.problems[0].endpoints[0].endpoint").value("POST /odeysysadmin/Booking2/search"))
                .andExpect(jsonPath("$.problems[0].endpoints[0].calls").value(2))
                .andExpect(jsonPath("$.problems[0].example.lineId").value("c:812"));
        mvc.perform(post("/call-logs/problems/calls").contentType(MediaType.APPLICATION_JSON).content("{\"fingerprint\":\"not hex\"}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void theBridgeReachesSlicesOnlyThroughTheirPortsAndDomain() {
        JavaClasses classes = new ClassFileImporter().withImportOption(ImportOption.Predefined.DO_NOT_INCLUDE_TESTS)
                .importPackages("com.fathy.alfred.backend");
        noClasses().that().resideInAPackage("..backend.investigationbridge..")
                .should().dependOnClassesThat().resideInAnyPackage("..application.service..", "..adapter..")
                .check(classes);
    }
}
