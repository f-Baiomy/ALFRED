package com.fathy.alfred.backend.calllogsbridge;

import com.fathy.alfred.backend.calllogsbridge.CallLogsModels.CallLogsPage;
import com.fathy.alfred.backend.calllogsbridge.CallLogsModels.LinkedLogLine;
import com.fathy.alfred.backend.calllogsbridge.CallLogsModels.Match;
import com.fathy.alfred.backend.calllogsbridge.CallLogsModels.Setup;
import com.fathy.alfred.backend.calllogsbridge.CallWindows.Window;
import com.fathy.alfred.backend.dbcapture.application.port.in.CallThreadsUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.ManageDbCaptureUseCase;
import com.fathy.alfred.backend.dbcapture.domain.model.CallOnThread;
import com.fathy.alfred.backend.internalcalls.application.port.in.GetCallDetailUseCase;
import com.fathy.alfred.backend.internalcalls.domain.model.CallSummary;
import com.fathy.alfred.backend.logs.application.port.in.KeptLogLinesUseCase;
import com.fathy.alfred.backend.logs.application.port.in.ManageLogSourcesUseCase;
import com.fathy.alfred.backend.logs.application.port.in.ManageLogSourcesUseCase.SourceView;
import com.fathy.alfred.backend.logs.application.port.in.ManageProjectLogsUseCase;
import com.fathy.alfred.backend.logs.application.port.in.QueryLogsUseCase;
import com.fathy.alfred.backend.logs.domain.model.FieldDef;
import com.fathy.alfred.backend.logs.domain.model.KeptLogLine;
import com.fathy.alfred.backend.logs.domain.model.LogLine;
import com.fathy.alfred.backend.logs.domain.model.LogLineSummary;
import com.fathy.alfred.backend.logs.domain.model.LogPage;
import com.fathy.alfred.backend.logs.domain.model.LogQuery;
import com.fathy.alfred.backend.logs.domain.model.LogSource;
import com.fathy.alfred.backend.logs.domain.model.LogStructure;
import com.fathy.alfred.backend.logs.domain.model.ProjectLogSettings;
import com.fathy.alfred.backend.logs.domain.model.Role;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListCapturedInternalCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedInternalCallSummary;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedInternalCallsPage;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.atLeastOnce;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class CallLogsServiceTest {

    private static final String PROJECT = "odeysys";
    private static final String CALL = "c1";
    private static final String THREAD = "default task-7";
    private static final long START = Instant.parse("2026-10-06T10:00:00Z").toEpochMilli();

    private final ManageProjectLogsUseCase projectLogs = mock(ManageProjectLogsUseCase.class);
    private final KeptLogLinesUseCase kept = mock(KeptLogLinesUseCase.class);
    private final ManageLogSourcesUseCase sources = mock(ManageLogSourcesUseCase.class);
    private final QueryLogsUseCase logs = mock(QueryLogsUseCase.class);
    private final ManageDbCaptureUseCase capture = mock(ManageDbCaptureUseCase.class);
    private final CallThreadsUseCase threads = mock(CallThreadsUseCase.class);
    private final GetCallDetailUseCase calls = mock(GetCallDetailUseCase.class);
    private final ListCapturedInternalCallsUseCase cycleCalls = mock(ListCapturedInternalCallsUseCase.class);

    private CallLogsService service;
    /** sourceId -> lines in it; the fake applies the EQ / NOT_EXISTS pills and the time range like the logs slice would. */
    private final Map<String, List<FakeLine>> data = new HashMap<>();

    record FakeLine(String lineId, long ts, String level, Map<String, Object> fields) {
    }

    @BeforeEach
    void setUp() {
        service = new CallLogsService(projectLogs, kept, sources, logs, capture, threads, calls, cycleCalls);
        when(capture.logsLinked(PROJECT)).thenReturn(true);
        when(kept.kept(anyString())).thenReturn(List.of());
        when(calls.getSummary(CALL)).thenReturn(Optional.of(summary(CALL, START, 1000)));
        settings(List.of("s1"));
        source("s1", "server.log", true);
        when(logs.lines(anyString(), any())).thenAnswer(inv -> page(inv.getArgument(0), inv.getArgument(1)));
        when(logs.line(anyString(), anyString())).thenAnswer(inv -> full(inv.getArgument(0), inv.getArgument(1)));
        when(threads.requestThread(CALL)).thenReturn(Optional.of(THREAD));
        when(threads.callsOnThread(eq(THREAD), any(), any())).thenReturn(List.of(new CallOnThread(CALL, Instant.ofEpochMilli(START).toString())));
    }

    // ------------------------------------------------------------------ thread and time

    @Test
    void linesOfTheRequestThreadInsideTheWindowPlusSkewAreLinked() {
        line("s1", "before-skew", START - 201, THREAD);
        line("s1", "skew-start", START - 200, THREAD);
        line("s1", "inside", START + 500, THREAD);
        line("s1", "skew-end", START + 1200, THREAD);
        line("s1", "after-skew", START + 1201, THREAD);
        line("s1", "other-thread", START + 500, "default task-9");

        CallLogsPage page = service.lines(CALL, null, null, 0).orElseThrow();

        assertThat(page.setup()).isEqualTo(Setup.OK);
        assertThat(page.matchedBy()).isEqualTo(Match.THREAD_TIME);
        assertThat(page.thread()).isEqualTo(THREAD);
        assertThat(page.lines()).extracting(LinkedLogLine::lineId).containsExactly("skew-start", "inside", "skew-end");
        assertThat(page.lines().get(0).offsetMs()).isEqualTo(-200);
        assertThat(page.lines().get(1).message()).isEqualTo("msg inside");
        assertThat(page.lines().get(1).raw()).isEqualTo("raw inside");
    }

    @Test
    void aLineNearerANeighbouringCallOnTheSameThreadGoesToThatCall() {
        when(calls.getSummary("c2")).thenReturn(Optional.of(summary("c2", START + 1100, 1000)));
        when(threads.callsOnThread(eq(THREAD), any(), any()))
                .thenReturn(List.of(new CallOnThread(CALL, Instant.ofEpochMilli(START).toString()), new CallOnThread("c2", Instant.ofEpochMilli(START + 1100).toString())));
        line("s1", "mine", START + 900, THREAD);       // middle 500 vs 1600: mine
        line("s1", "theirs", START + 1150, THREAD);    // 650 vs 450: theirs

        CallLogsPage page = service.lines(CALL, null, null, 0).orElseThrow();

        assertThat(page.lines()).extracting(LinkedLogLine::lineId).containsExactly("mine");
    }

    @Test
    void timesAreCompardAsUtcInstantsWhateverTheSourceTimeZone() {
        // the logs slice stores a +04:00 "14:00:00.300" as its UTC instant; the join only ever sees that instant
        long dubaiLocalAsUtc = Instant.parse("2026-10-06T14:00:00.300+04:00").toEpochMilli();
        line("s1", "dubai", dubaiLocalAsUtc, THREAD);

        assertThat(service.lines(CALL, null, null, 0).orElseThrow().lines()).extracting(LinkedLogLine::offsetMs).containsExactly(300L);
    }

    @Test
    void aLineTaggedWithAnotherCallsIdIsNeverTimeMatched() {
        line("s1", "untagged", START + 100, THREAD);
        line("s1", "tagged-other", START + 200, THREAD, Map.of("mdc.alfred.call", "c9"));

        CallLogsPage page = service.lines(CALL, null, null, 0).orElseThrow();

        assertThat(page.lines()).extracting(LinkedLogLine::lineId).containsExactly("untagged");
    }

    @Test
    void everyLineCarriesItsSourceAcrossTwoSources() {
        settings(List.of("s1", "s2"));
        source("s2", "app.log", true);
        line("s1", "a", START + 100, THREAD);
        line("s2", "b", START + 50, THREAD);

        CallLogsPage page = service.lines(CALL, null, null, 0).orElseThrow();

        assertThat(page.lines()).extracting(LinkedLogLine::lineId).containsExactly("b", "a");
        assertThat(page.lines()).extracting(LinkedLogLine::sourceName).containsExactly("app.log", "server.log");
    }

    @Test
    void pagesWithACursorUntilTheLastLine() {
        for (int i = 0; i < 5; i++) {
            line("s1", "l" + i, START + i, THREAD);
        }

        CallLogsPage first = service.lines(CALL, null, null, 2).orElseThrow();
        CallLogsPage second = service.lines(CALL, null, first.next(), 2).orElseThrow();
        CallLogsPage last = service.lines(CALL, null, second.next(), 2).orElseThrow();

        assertThat(first.lines()).extracting(LinkedLogLine::lineId).containsExactly("l0", "l1");
        assertThat(second.lines()).extracting(LinkedLogLine::lineId).containsExactly("l2", "l3");
        assertThat(last.lines()).extracting(LinkedLogLine::lineId).containsExactly("l4");
        assertThat(last.next()).isNull();
    }

    // ------------------------------------------------------------------ exact

    @Test
    void linesTaggedWithTheCallsIdWinOverTimeMatching() {
        line("s1", "tagged", START + 5000, "worker-1", Map.of("mdc.alfred.call", CALL));
        line("s1", "untagged", START + 100, THREAD);

        CallLogsPage page = service.lines(CALL, null, null, 0).orElseThrow();

        assertThat(page.matchedBy()).isEqualTo(Match.EXACT);
        assertThat(page.lines()).extracting(LinkedLogLine::lineId).containsExactly("tagged");
        assertThat(page.lines().get(0).matchedBy()).isEqualTo(Match.EXACT);
    }

    @Test
    void aCallWithoutCaptureGetsItsTaggedLinesExactly() {
        when(threads.requestThread(CALL)).thenReturn(Optional.empty()); // db=0: no CALL_OPEN, no thread
        line("s1", "tagged", START + 10, "default task-3", Map.of("mdc.alfred.call", CALL));

        CallLogsPage page = service.lines(CALL, null, null, 0).orElseThrow();

        assertThat(page.setup()).isEqualTo(Setup.OK);
        assertThat(page.matchedBy()).isEqualTo(Match.EXACT);
        assertThat(page.lines()).extracting(LinkedLogLine::lineId).containsExactly("tagged");
    }

    @Test
    void neighboursBeforeAndAfterTheSwitchWasTurnedOn() {
        // c0 ran before the switch was on (its lines untagged), CALL after (tagged); both on the same thread
        when(calls.getSummary("c0")).thenReturn(Optional.of(summary("c0", START - 1500, 1000)));
        when(threads.requestThread("c0")).thenReturn(Optional.of(THREAD));
        when(threads.callsOnThread(eq(THREAD), any(), any())).thenReturn(List.of(
                new CallOnThread("c0", Instant.ofEpochMilli(START - 1500).toString()), new CallOnThread(CALL, Instant.ofEpochMilli(START).toString())));
        line("s1", "c0-untagged", START - 1000, THREAD);
        line("s1", "c0-edge", START - 400, THREAD);
        line("s1", "mine-tagged", START + 100, THREAD, Map.of("mdc.alfred.call", CALL));

        assertThat(service.lines(CALL, null, null, 0).orElseThrow().lines()).extracting(LinkedLogLine::lineId).containsExactly("mine-tagged");
        CallLogsPage before = service.lines("c0", null, null, 0).orElseThrow();
        assertThat(before.matchedBy()).isEqualTo(Match.THREAD_TIME);
        assertThat(before.lines()).extracting(LinkedLogLine::lineId).containsExactly("c0-untagged", "c0-edge");
    }

    // ------------------------------------------------------------------ setup states

    @Test
    void switchOffReadsNoLogsButServesKeptLines() {
        when(capture.logsLinked(PROJECT)).thenReturn(false);
        when(kept.kept(CALL)).thenReturn(List.of(new KeptLogLine(CALL, "s1", "server.log", "k1", START + 10, "INFO", THREAD, "a.B", "kept msg",
                "THREAD_TIME", "raw k1", KeptLogLine.Origin.CYCLE)));

        CallLogsPage page = service.lines(CALL, null, null, 0).orElseThrow();

        assertThat(page.setup()).isEqualTo(Setup.LINKING_OFF);
        assertThat(page.lines()).extracting(LinkedLogLine::lineId).containsExactly("k1");
        assertThat(page.lines().get(0).kept()).isTrue();
        verify(logs, never()).lines(anyString(), any());
        verify(logs, never()).line(anyString(), anyString());
        verify(sources, never()).structure(anyString());
    }

    @Test
    void noSourceAndNoThreadAreReported() {
        settings(List.of());
        assertThat(service.lines(CALL, null, null, 0).orElseThrow().setup()).isEqualTo(Setup.NO_SOURCE);

        settings(List.of("s1"));
        when(threads.requestThread(CALL)).thenReturn(Optional.empty());
        assertThat(service.lines(CALL, null, null, 0).orElseThrow().setup()).isEqualTo(Setup.NO_THREAD);

        // a log without the thread field cannot be matched by thread either
        when(threads.requestThread(CALL)).thenReturn(Optional.of(THREAD));
        when(projectLogs.settings(PROJECT)).thenReturn(new ProjectLogSettings(PROJECT, List.of("s1"), "process.thread.name", null, null, 200));
        assertThat(service.lines(CALL, null, null, 0).orElseThrow().setup()).isEqualTo(Setup.NO_THREAD);
    }

    @Test
    void anUnknownCallIsEmptyAndACycleCopyIsFoundById() {
        assertThat(service.lines("nope", null, null, 0)).isEmpty();

        when(cycleCalls.listCalls(eq("cy1"), any())).thenReturn(Optional.of(new CapturedInternalCallsPage(List.of(
                new CapturedInternalCallSummary("x", "2026-10-06T10:00:00Z", summary("old-c1x", START, 100)),
                new CapturedInternalCallSummary("y", "2026-10-06T10:00:00Z", summary("old-c1", START, 100))), 2)));
        line("s1", "in", START + 50, THREAD);
        when(threads.requestThread("old-c1")).thenReturn(Optional.of(THREAD));

        CallLogsPage page = service.lines("old-c1", "cy1", null, 0).orElseThrow();

        assertThat(page.callId()).isEqualTo("old-c1");
        assertThat(page.lines()).extracting(LinkedLogLine::lineId).containsExactly("in");
    }

    @Test
    void countsUseSummariesOnly() {
        line("s1", "e", START + 1, THREAD, Map.of(), "ERROR");
        line("s1", "w", START + 2, THREAD, Map.of(), "WARNING");
        line("s1", "i", START + 3, THREAD);

        var counts = service.counts(List.of(CALL, "unknown"));

        assertThat(counts).containsOnlyKeys(CALL);
        assertThat(counts.get(CALL).lines()).isEqualTo(3);
        assertThat(counts.get(CALL).errors()).isEqualTo(1);
        assertThat(counts.get(CALL).warnings()).isEqualTo(1);
        verify(logs, never()).line(anyString(), anyString());
    }

    @Test
    void timeQueryIsBoundedByTheWindowAndExcludesTaggedLines() {
        line("s1", "x", START, THREAD);
        service.lines(CALL, null, null, 0);

        ArgumentCaptor<LogQuery> q = ArgumentCaptor.forClass(LogQuery.class);
        verify(logs, atLeastOnce()).lines(eq("s1"), q.capture());
        LogQuery byTime = q.getAllValues().stream().filter(x -> x.from() != null).findFirst().orElseThrow();
        assertThat(byTime.from()).isEqualTo(START - 200);
        assertThat(byTime.to()).isEqualTo(START + 1200);
        assertThat(byTime.pills()).extracting(LogQuery.Pill::op).containsExactly(LogQuery.Op.EQ, LogQuery.Op.NOT_EXISTS);
    }

    // ------------------------------------------------------------------ kept lines

    @Test
    @SuppressWarnings("unchecked")
    void aCycleCallsLinesAreKeptAndMergedWithLiveOnesByLine() {
        line("s1", "a", START + 10, THREAD);
        line("s1", "b", START + 20, THREAD);
        when(kept.kept(CALL)).thenReturn(List.of(
                new KeptLogLine(CALL, "s1", "server.log", "a", START + 10, "INFO", THREAD, null, "old copy", "THREAD_TIME", "raw", KeptLogLine.Origin.CYCLE),
                new KeptLogLine(CALL, "s1", "server.log", "gone", START + 5, "INFO", THREAD, null, "rotated away", "THREAD_TIME", "raw", KeptLogLine.Origin.CYCLE)));

        CallLogsPage page = service.lines(CALL, "cy1", null, 0).orElseThrow();

        assertThat(page.lines()).extracting(LinkedLogLine::lineId).containsExactly("gone", "a", "b");
        assertThat(page.lines()).extracting(LinkedLogLine::kept).containsExactly(true, false, false);
        ArgumentCaptor<List<KeptLogLine>> stored = ArgumentCaptor.forClass(List.class);
        verify(kept).keep(stored.capture());
        assertThat(stored.getValue()).extracting(KeptLogLine::lineId).containsExactly("a", "b");
        assertThat(stored.getValue()).allMatch(k -> k.origin() == KeptLogLine.Origin.CYCLE && k.raw().equals("raw " + k.lineId()));
    }

    @Test
    void aLiveCallReadOutsideACycleKeepsNothing() {
        line("s1", "a", START + 10, THREAD);
        service.lines(CALL, null, null, 0);
        verify(kept, never()).keep(any());
    }

    @Test
    @SuppressWarnings("unchecked")
    void importedLinesAreKeptAsGiven() {
        LinkedLogLine l = new LinkedLogLine("s9", "old.log", "x:1", "2026-10-06T10:00:00.050Z", 50, "WARN", "t", "a.B", "m", Match.EXACT, false, "{}");

        assertThat(service.importLines("imp-1", List.of(l))).isEqualTo(1);

        ArgumentCaptor<List<KeptLogLine>> stored = ArgumentCaptor.forClass(List.class);
        verify(kept).keep(stored.capture());
        KeptLogLine k = stored.getValue().get(0);
        assertThat(k.callId()).isEqualTo("imp-1");
        assertThat(k.origin()).isEqualTo(KeptLogLine.Origin.IMPORT);
        assertThat(k.atMs()).isEqualTo(START + 50);
        assertThat(k.matchedBy()).isEqualTo("EXACT");
    }

    // ------------------------------------------------------------------ a line's call

    @Test
    void aLineFindsItsCallByIdOrByThreadAndTime() {
        when(projectLogs.readingSource("s1")).thenReturn(List.of(new ProjectLogSettings(PROJECT, List.of("s1"), "thread", null, null, 200)));
        line("s1", "tagged", START + 9000, "other", Map.of("mdc.alfred.call", CALL));
        line("s1", "timed", START + 400, THREAD);
        line("s1", "elsewhere", START + 400, "default task-9");

        assertThat(service.forLine("s1", "tagged").orElseThrow()).satisfies(c -> {
            assertThat(c.call().id()).isEqualTo(CALL);
            assertThat(c.matchedBy()).isEqualTo(Match.EXACT);
        });
        assertThat(service.forLine("s1", "timed").orElseThrow().matchedBy()).isEqualTo(Match.THREAD_TIME);
        assertThat(service.forLine("s1", "elsewhere")).isEmpty();
    }

    @Test
    void aLineOfAProjectWithTheSwitchOffFindsNothingAndIsNotRead() {
        when(projectLogs.readingSource("s1")).thenReturn(List.of(new ProjectLogSettings(PROJECT, List.of("s1"), "thread", null, null, 200)));
        when(capture.logsLinked(PROJECT)).thenReturn(false);
        line("s1", "timed", START + 400, THREAD);

        assertThat(service.forLine("s1", "timed")).isEmpty();
        verify(logs, never()).line(anyString(), anyString());
    }

    // ------------------------------------------------------------------ the window rule directly

    @Test
    void windowRuleEdges() {
        Window self = new Window("a", 1000, 2000);
        assertThat(CallWindows.belongsTo(self, List.of(), 800, 200)).isTrue();
        assertThat(CallWindows.belongsTo(self, List.of(), 799, 200)).isFalse();
        assertThat(CallWindows.belongsTo(self, List.of(), 2200, 200)).isTrue();
        assertThat(CallWindows.belongsTo(self, List.of(), 2201, 200)).isFalse();
        Window next = new Window("b", 2100, 3100);
        assertThat(CallWindows.belongsTo(self, List.of(next), 2050, 200)).isTrue();   // 550 vs 550: tie stays
        assertThat(CallWindows.belongsTo(self, List.of(next), 2150, 200)).isFalse();
        assertThat(CallWindows.belongsTo(self, List.of(self), 1500, 0)).isTrue();
    }

    // ------------------------------------------------------------------ fakes

    private void settings(List<String> sourceIds) {
        when(projectLogs.settings(PROJECT)).thenReturn(new ProjectLogSettings(PROJECT, sourceIds, "thread", null, null, 200));
    }

    private void source(String id, String name, boolean hasCallId) {
        List<FieldDef> fields = new ArrayList<>();
        fields.add(field("thread", Role.CORRELATION));
        fields.add(field("message", Role.MESSAGE));
        fields.add(field("logger", null));
        if (hasCallId) {
            fields.add(field("mdc.alfred.call", null));
        }
        LogStructure structure = mock(LogStructure.class);
        when(structure.fields()).thenReturn(fields);
        when(sources.structure(id)).thenReturn(structure);
        LogSource src = mock(LogSource.class);
        when(src.name()).thenReturn(name);
        SourceView view = mock(SourceView.class);
        when(view.source()).thenReturn(src);
        when(sources.get(id)).thenReturn(view);
        data.putIfAbsent(id, new ArrayList<>());
    }

    private static FieldDef field(String label, Role role) {
        FieldDef f = mock(FieldDef.class);
        when(f.label()).thenReturn(label);
        when(f.role()).thenReturn(role);
        when(f.stored()).thenReturn(true);
        return f;
    }

    private void line(String source, String id, long ts, String thread) {
        line(source, id, ts, thread, Map.of(), "INFO");
    }

    private void line(String source, String id, long ts, String thread, Map<String, Object> extra) {
        line(source, id, ts, thread, extra, "INFO");
    }

    private void line(String source, String id, long ts, String thread, Map<String, Object> extra, String level) {
        Map<String, Object> fields = new HashMap<>(extra);
        fields.put("thread", thread);
        fields.put("message", "msg " + id);
        fields.put("logger", "com.acme.Svc");
        data.computeIfAbsent(source, k -> new ArrayList<>()).add(new FakeLine(id, ts, level, fields));
    }

    private LogPage page(String source, LogQuery q) {
        List<LogLineSummary> out = data.getOrDefault(source, List.of()).stream()
                .filter(l -> q.from() == null || l.ts() >= q.from())
                .filter(l -> q.to() == null || l.ts() <= q.to())
                .filter(l -> q.pills().stream().allMatch(p -> switch (p.op()) {
                    case EQ -> p.value().equals(l.fields().get(p.field()));
                    case NOT_EXISTS -> !l.fields().containsKey(p.field());
                    default -> true;
                }))
                .sorted((a, b) -> Long.compare(a.ts(), b.ts()))
                .map(l -> new LogLineSummary(l.lineId(), l.ts(), l.level(), 0, null, null, false, false, 0, l.fields(), 0))
                .toList();
        return new LogPage(out, out.size(), null, 1, false);
    }

    private LogLine full(String source, String lineId) {
        FakeLine l = data.get(source).stream().filter(x -> x.lineId().equals(lineId)).findFirst().orElseThrow();
        return new LogLine(l.lineId(), "in", 0, l.ts(), l.level(), 0, null, null, false, false, 0, l.fields(), "raw " + lineId, null);
    }

    private static CallSummary summary(String id, long startMs, double durationMs) {
        String ts = Instant.ofEpochMilli(startMs).toString().replace("Z", "+00:00");
        return new CallSummary(id, "http://localhost/" + id, "http://x/" + id, "POST", ts, durationMs, 200, null, null, null,
                null, null, PROJECT, null);
    }
}
