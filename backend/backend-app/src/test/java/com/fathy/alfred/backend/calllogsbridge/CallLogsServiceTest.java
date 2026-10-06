package com.fathy.alfred.backend.calllogsbridge;

import com.fathy.alfred.backend.calllogsbridge.CallLogsModels.CallLogsPage;
import com.fathy.alfred.backend.calllogsbridge.CallLogsModels.LinkedLogLine;
import com.fathy.alfred.backend.calllogsbridge.CallLogsModels.Match;
import com.fathy.alfred.backend.calllogsbridge.CallLogsModels.Setup;
import com.fathy.alfred.backend.dbcapture.application.port.in.CallLogLinesUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.ManageDbCaptureUseCase;
import com.fathy.alfred.backend.dbcapture.domain.model.CaughtLogCounts;
import com.fathy.alfred.backend.dbcapture.domain.model.CaughtLogLine;
import com.fathy.alfred.backend.internalcalls.application.port.in.GetCallDetailUseCase;
import com.fathy.alfred.backend.internalcalls.domain.model.CallSummary;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListCapturedInternalCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedInternalCallSummary;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedInternalCallsPage;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** A call's lines come only from what the agent caught (specs/009-agent-log-capture) - no log file, no Logs tab. */
class CallLogsServiceTest {

    private static final String PROJECT = "odeysys";
    private static final String CALL = "c1";
    private static final long START = Instant.parse("2026-10-06T10:00:00Z").toEpochMilli();

    private final ManageDbCaptureUseCase capture = mock(ManageDbCaptureUseCase.class);
    private final GetCallDetailUseCase calls = mock(GetCallDetailUseCase.class);
    private final ListCapturedInternalCallsUseCase cycleCalls = mock(ListCapturedInternalCallsUseCase.class);
    private final CallLogLinesUseCase caught = mock(CallLogLinesUseCase.class);
    private CallLogsService service;

    @BeforeEach
    void setUp() {
        service = new CallLogsService(capture, calls, cycleCalls, caught);
        when(calls.getSummary(CALL)).thenReturn(Optional.of(summary(CALL, START, 1000)));
        when(capture.logsLinked(PROJECT)).thenReturn(true);
    }

    private static CaughtLogLine line(long id, int seq, long atMs, String level, String message) {
        return new CaughtLogLine(id, CALL, seq, Instant.ofEpochMilli(atMs).toString(), level, "com.app.Search", "default task-4", message,
                null, null, null, false, PROJECT);
    }

    @Test
    void aCaughtCallListsItsLinesInItsOwnOrder() {
        when(caught.caughtFor(CALL)).thenReturn(true);
        when(caught.lines(CALL, -1, 200)).thenReturn(List.of(line(7, 3, START + 40, "WARN", "slow supplier"),
                new CaughtLogLine(8, CALL, 9, Instant.ofEpochMilli(START + 900).toString(), "ERROR", "com.app.Search", "default task-4", "boom",
                        "java.lang.IllegalStateException", "bad", "java.lang.IllegalStateException: bad", true, PROJECT)));
        when(caught.counts(List.of(CALL))).thenReturn(Map.of(CALL, new CaughtLogCounts(2, 1, 1, 4)));

        CallLogsPage page = service.lines(CALL, null, null, 0).orElseThrow();

        assertThat(page.setup()).isEqualTo(Setup.OK);
        assertThat(page.matchedBy()).isEqualTo(Match.CAUGHT);
        assertThat(page.dropped()).isEqualTo(4);
        assertThat(page.next()).isNull();
        assertThat(page.lines()).extracting(LinkedLogLine::message).containsExactly("slow supplier", "boom");
        assertThat(page.lines()).extracting(LinkedLogLine::offsetMs).containsExactly(40L, 900L);
        assertThat(page.lines()).extracting(LinkedLogLine::seq).containsExactly(3, 9);
        LinkedLogLine boom = page.lines().get(1);
        assertThat(boom.lineId()).isEqualTo("c:8");
        assertThat(boom.exception().type()).isEqualTo("java.lang.IllegalStateException");
        assertThat(boom.raw()).contains("\"exception\"").contains("\"cut\":true");
    }

    @Test
    void pagesByTheCallsSeq() {
        when(caught.caughtFor(CALL)).thenReturn(true);
        when(caught.lines(CALL, -1, 2)).thenReturn(List.of(line(1, 1, START, "INFO", "a"), line(2, 4, START, "INFO", "b")));
        when(caught.lines(CALL, 4, 2)).thenReturn(List.of(line(3, 6, START, "INFO", "c")));

        CallLogsPage first = service.lines(CALL, null, null, 2).orElseThrow();
        CallLogsPage second = service.lines(CALL, null, first.next(), 2).orElseThrow();

        assertThat(first.next()).isEqualTo("s:4");
        assertThat(second.lines()).extracting(LinkedLogLine::message).containsExactly("c");
        assertThat(second.next()).isNull();
    }

    @Test
    void aCallNothingWasCaughtForSaysWhy() {
        assertThat(service.lines(CALL, null, null, 0).orElseThrow().setup()).isEqualTo(Setup.NO_AGENT);
        when(capture.logsLinked(PROJECT)).thenReturn(false);
        assertThat(service.lines(CALL, null, null, 0).orElseThrow().setup()).isEqualTo(Setup.LINKING_OFF);
        verify(caught, never()).lines(anyString(), anyInt(), anyInt());
    }

    @Test
    void anUnknownCallIsEmptyAndACycleCopyIsFoundById() {
        assertThat(service.lines("nope", null, null, 0)).isEmpty();
        when(cycleCalls.listCalls(eq("cy1"), any())).thenReturn(Optional.of(new CapturedInternalCallsPage(List.of(
                new CapturedInternalCallSummary("y", "2026-10-06T10:00:00Z", summary("old-c1", START, 100))), 1)));
        when(caught.caughtFor("old-c1")).thenReturn(true);
        when(caught.lines("old-c1", -1, 200)).thenReturn(List.of());

        assertThat(service.lines("old-c1", "cy1", null, 0).orElseThrow().callId()).isEqualTo("old-c1");
    }

    @Test
    void countsComeFromWhatWasStoredAndLeaveOutCallsWithoutLines() {
        when(caught.counts(List.of(CALL, "c2", "c3"))).thenReturn(Map.of(CALL, new CaughtLogCounts(12, 2, 3, 0), "c2", new CaughtLogCounts(0, 0, 0, 5)));

        var counts = service.counts(List.of(CALL, "c2", "c3"));

        assertThat(counts).containsOnlyKeys(CALL);
        assertThat(counts.get(CALL)).isEqualTo(new CallLogsModels.LogCounts(12, 2, 3, Match.CAUGHT));
    }

    @Test
    @SuppressWarnings("unchecked")
    void importedLinesAreStoredWithTheCall() {
        LinkedLogLine l = new LinkedLogLine("agent", "caught by the agent", "c:1", "2026-10-06T10:00:00.050Z", 50, "WARN", "t", "a.B", "m",
                Match.CAUGHT, false, "{}", new CallLogsModels.LogException("java.lang.X", "x", "stack"), 7);

        assertThat(service.importLines("imp-1", List.of(l))).isEqualTo(1);

        ArgumentCaptor<List<CaughtLogLine>> stored = ArgumentCaptor.forClass(List.class);
        verify(caught).importLines(eq("imp-1"), stored.capture());
        CaughtLogLine s = stored.getValue().get(0);
        assertThat(s.seq()).isEqualTo(7);
        assertThat(s.exceptionType()).isEqualTo("java.lang.X");
        assertThat(s.level()).isEqualTo("WARN");
    }

    private static CallSummary summary(String id, long startMs, double durationMs) {
        String ts = Instant.ofEpochMilli(startMs).toString().replace("Z", "+00:00");
        return new CallSummary(id, "http://localhost/" + id, "http://x/" + id, "POST", ts, durationMs, 200, null, null, null,
                null, null, PROJECT, null);
    }
}
