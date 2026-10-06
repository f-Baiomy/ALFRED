package com.fathy.alfred.backend.calllogsbridge;

import com.fathy.alfred.backend.calllogsbridge.CallLogsModels.CallLogsPage;
import com.fathy.alfred.backend.calllogsbridge.CallLogsModels.LinkedLogLine;
import com.fathy.alfred.backend.calllogsbridge.CallLogsModels.LogCounts;
import com.fathy.alfred.backend.calllogsbridge.CallLogsModels.Match;
import com.fathy.alfred.backend.calllogsbridge.CallLogsModels.Setup;
import com.fathy.alfred.backend.calllogsbridge.CallWindows.Window;
import com.fathy.alfred.backend.dbcapture.application.port.in.CallLogLinesUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.CallThreadsUseCase;
import com.fathy.alfred.backend.dbcapture.domain.model.CaughtLogCounts;
import com.fathy.alfred.backend.dbcapture.domain.model.CaughtLogLine;
import com.fathy.alfred.backend.dbcapture.application.port.in.ManageDbCaptureUseCase;
import com.fathy.alfred.backend.dbcapture.domain.model.CallOnThread;
import com.fathy.alfred.backend.internalcalls.application.port.in.GetCallDetailUseCase;
import com.fathy.alfred.backend.internalcalls.domain.model.CallSummary;
import com.fathy.alfred.backend.internalcalls.domain.model.CallsQuery;
import com.fathy.alfred.backend.logs.application.port.in.KeptLogLinesUseCase;
import com.fathy.alfred.backend.logs.application.port.in.ManageLogSourcesUseCase;
import com.fathy.alfred.backend.logs.application.port.in.ManageProjectLogsUseCase;
import com.fathy.alfred.backend.logs.application.port.in.ManageProjectLogsUseCase.ProjectLogsView;
import com.fathy.alfred.backend.logs.application.port.in.QueryLogsUseCase;
import com.fathy.alfred.backend.logs.domain.model.FieldDef;
import com.fathy.alfred.backend.logs.domain.model.KeptLogLine;
import com.fathy.alfred.backend.logs.domain.model.LogLine;
import com.fathy.alfred.backend.logs.domain.model.LogLineSummary;
import com.fathy.alfred.backend.logs.domain.model.LogPage;
import com.fathy.alfred.backend.logs.domain.model.LogQuery;
import com.fathy.alfred.backend.logs.domain.model.LogStructure;
import com.fathy.alfred.backend.logs.domain.model.ProjectLogFields;
import com.fathy.alfred.backend.logs.domain.model.ProjectLogSettings;
import com.fathy.alfred.backend.logs.domain.model.Role;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListCapturedInternalCallsUseCase;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;

/**
 * Logs linked to calls (specs/008-logs-call-link): the one place that joins a project's inbound calls (their window),
 * database capture (their request thread, the ▤ switch) and the Logs tab (the project's log sources and their lines).
 * It lives in the composition root because it needs all three; each slice stays independent and is reached only
 * through its use-case ports. Logs are read only while the project's ▤ switch and inbound logging are on (FR-006);
 * kept copies (session-cycle and imported calls) are served either way - they are ALFRED's own data.
 *
 * <p>Matching: lines carrying this call's id (exact) win; otherwise the lines of the call's request thread whose time
 * falls in the call's window ± the clock difference, minus lines carrying any call id and lines nearer a neighbouring
 * call on the same thread (FR-004). Times are the logs' typed epoch-ms values - UTC whatever the source's time zone.
 * Nothing here logs line content (FR-018a): ids, counts and timings only.
 */
@Service
public class CallLogsService {

    private static final Logger log = LoggerFactory.getLogger(CallLogsService.class);

    /** Lines considered per call (all sources): a call is a bounded request, this is a seatbelt. */
    static final int MAX_LINES_PER_CALL = 5_000;
    static final int MAX_PAGE = 500;
    static final int DEFAULT_PAGE = 200;
    /** Calls opened before a window that are still considered: a thread runs one request at a time, so the last two. */
    static final int PREVIOUS_CALLS = 2;
    private static final String CURSOR = "o:";

    private final ManageProjectLogsUseCase projectLogs;
    private final KeptLogLinesUseCase keptLines;
    private final ManageLogSourcesUseCase logSources;
    private final QueryLogsUseCase logs;
    private final ManageDbCaptureUseCase capture;
    private final CallThreadsUseCase threads;
    private final GetCallDetailUseCase inboundCalls;
    private final ListCapturedInternalCallsUseCase cycleCalls;
    /** Lines the agent caught inside the call (specs/009-agent-log-capture) - they win over log files for that call. */
    private final CallLogLinesUseCase caught;

    public CallLogsService(ManageProjectLogsUseCase projectLogs, KeptLogLinesUseCase keptLines, ManageLogSourcesUseCase logSources,
                           QueryLogsUseCase logs, ManageDbCaptureUseCase capture, CallThreadsUseCase threads,
                           GetCallDetailUseCase inboundCalls, ListCapturedInternalCallsUseCase cycleCalls, CallLogLinesUseCase caught) {
        this.caught = caught;
        this.projectLogs = projectLogs;
        this.keptLines = keptLines;
        this.logSources = logSources;
        this.logs = logs;
        this.capture = capture;
        this.threads = threads;
        this.inboundCalls = inboundCalls;
        this.cycleCalls = cycleCalls;
    }

    // ------------------------------------------------------------------ settings

    public ProjectLogsView settings(String project) {
        return projectLogs.view(project);
    }

    public ProjectLogsView saveSettings(ProjectLogSettings settings) {
        return projectLogs.save(settings);
    }

    // ------------------------------------------------------------------ a call's lines

    /** The call's linked lines, oldest first, one page. Empty when the call is unknown. */
    public Optional<CallLogsPage> lines(String callId, String cycleId, String after, int limit) {
        return resolve(callId, cycleId).map(call -> {
            if (caught.caughtFor(call.id())) {
                return caughtPage(call, after, limit);
            }
            Linked linked = link(call);
            int size = limit <= 0 ? DEFAULT_PAGE : Math.min(limit, MAX_PAGE);
            int from = offset(after);
            List<Hit> page = linked.hits().subList(Math.min(from, linked.hits().size()), Math.min(from + size, linked.hits().size()));
            List<LinkedLogLine> lines = page.stream().map(h -> h.line(call.startMs())).toList();
            if (cycleId != null && !cycleId.isBlank() && linked.setup() == Setup.OK) {
                keepLive(call, lines); // a cycle call's lines outlive the log source's retention (FR-005a)
            }
            String next = from + size < linked.hits().size() ? CURSOR + (from + size) : null;
            return new CallLogsPage(call.id(), linked.setup(), linked.match(), linked.thread(), linked.skewMs(), lines, next);
        });
    }

    /** Counts per call - no line is read in full (FR-013). Unknown calls are left out. */
    public Map<String, LogCounts> counts(List<String> callIds) {
        return counts(callIds, null);
    }

    // ------------------------------------------------------------------ caught by the agent (specs/009-agent-log-capture)

    private static final String SEQ_CURSOR = "s:";
    private static final com.fasterxml.jackson.databind.ObjectMapper JSON = new com.fasterxml.jackson.databind.ObjectMapper();

    /** A caught call's lines in its own order (seq) - the agent already attached them; no log is read. */
    private CallLogsPage caughtPage(CallInfo call, String after, int limit) {
        int size = limit <= 0 ? DEFAULT_PAGE : Math.min(limit, MAX_PAGE);
        int afterSeq = after != null && after.startsWith(SEQ_CURSOR) ? parseInt(after.substring(SEQ_CURSOR.length())) : 0;
        List<CaughtLogLine> page = caught.lines(call.id(), afterSeq, size);
        List<LinkedLogLine> lines = page.stream().map(l -> caughtLine(call, l)).toList();
        String next = page.size() == size ? SEQ_CURSOR + page.get(page.size() - 1).seq() : null;
        CaughtLogCounts counts = caught.counts(List.of(call.id())).get(call.id());
        return new CallLogsPage(call.id(), Setup.OK, Match.CAUGHT, null, 0, lines, next, counts == null ? 0 : counts.dropped());
    }

    static LinkedLogLine caughtLine(CallInfo call, CaughtLogLine l) {
        long atMs;
        try {
            atMs = Instant.parse(l.at()).toEpochMilli();
        } catch (RuntimeException e) {
            atMs = call.startMs();
        }
        CallLogsModels.LogException exception = l.exceptionType() == null && l.exceptionStack() == null ? null
                : new CallLogsModels.LogException(l.exceptionType(), l.exceptionMessage(), l.exceptionStack());
        // the line as JSON: what exports print whole and what masking (like bodies) applies to
        Map<String, Object> raw = new LinkedHashMap<>();
        raw.put("timestamp", l.at());
        raw.put("level", l.level());
        raw.put("logger", l.logger());
        raw.put("thread", l.thread());
        raw.put("message", l.message());
        if (exception != null) {
            raw.put("exception", Map.of("type", String.valueOf(exception.type()), "message", String.valueOf(exception.message()),
                    "stack", String.valueOf(exception.stack())));
        }
        if (l.cut()) {
            raw.put("cut", true);
        }
        String rawText;
        try {
            rawText = JSON.writeValueAsString(raw);
        } catch (Exception e) {
            rawText = String.valueOf(l.message());
        }
        return new LinkedLogLine("agent", "caught by the agent", "c:" + l.id(), l.at(), atMs - call.startMs(), l.level(), l.thread(),
                l.logger(), l.message(), Match.CAUGHT, false, rawText, exception, l.seq());
    }

    private static int parseInt(String s) {
        try {
            return Math.max(0, Integer.parseInt(s));
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    /**
     * Counts per call; with {@code cycleId} a call the live list no longer has is found through the cycle's copy, so a
     * cycle's cards (and imported calls) show their kept lines too.
     */
    public Map<String, LogCounts> counts(List<String> callIds, String cycleId) {
        Map<String, LogCounts> out = new LinkedHashMap<>();
        // caught calls: their counts are kept as the lines arrive - no line, no log is read
        Map<String, CaughtLogCounts> caughtCounts = callIds.isEmpty() ? Map.of() : caught.counts(callIds);
        for (String id : callIds) {
            CaughtLogCounts c = caughtCounts.get(id);
            if (c != null) {
                if (c.lines() > 0) {
                    out.put(id, new LogCounts(c.lines(), c.errors(), c.warnings(), Match.CAUGHT));
                }
                continue;
            }
            if (caught.caughtFor(id)) {
                continue; // caught, none yet
            }
            resolve(id, cycleId).ifPresent(call -> {
                Linked linked = link(call);
                if (linked.hits().isEmpty()) {
                    return;
                }
                int errors = (int) linked.hits().stream().filter(h -> "ERROR".equals(h.level())).count();
                int warnings = (int) linked.hits().stream().filter(h -> "WARN".equals(h.level())).count();
                out.put(id, new LogCounts(linked.hits().size(), errors, warnings, linked.match()));
            });
        }
        return out;
    }

    // ------------------------------------------------------------------ kept lines (US4)

    /**
     * Keeps every live line of a cycle's call as Alfred's own copy (origin CYCLE), so the cycle still shows them after
     * the log source has rotated them away. Returns how many lines were stored (already-kept ones are replaced).
     */
    public int keepForCycle(String callId, String cycleId) {
        if (caught.caughtFor(callId)) {
            return 0; // caught lines are stored with the call's statements, which a cycle already keeps
        }
        return resolve(callId, cycleId).map(call -> {
            Linked linked = link(call);
            if (linked.setup() != Setup.OK) {
                return 0;
            }
            List<LinkedLogLine> live = linked.hits().stream().filter(h -> h.kept() == null).map(h -> h.line(call.startMs())).toList();
            return keepLive(call, live);
        }).orElse(0);
    }

    private int keepLive(CallInfo call, List<LinkedLogLine> lines) {
        List<KeptLogLine> fresh = lines.stream().filter(l -> !l.kept()).map(l -> kept(call.id(), l, KeptLogLine.Origin.CYCLE)).toList();
        if (!fresh.isEmpty()) {
            keptLines.keep(fresh);
        }
        return fresh.size();
    }

    /** Lines of an imported call, kept as given (origin IMPORT) - they are the export's copy, not re-read from any log. */
    public int importLines(String callId, List<LinkedLogLine> lines) {
        List<KeptLogLine> kept = lines.stream().map(l -> kept(callId, l, KeptLogLine.Origin.IMPORT)).toList();
        if (!kept.isEmpty()) {
            keptLines.keep(kept);
        }
        log.debug("call-logs {}: {} imported lines kept", callId, kept.size());
        return kept.size();
    }

    /** Drops the kept lines of these calls (of either origin). */
    public int forget(java.util.Collection<String> callIds, KeptLogLine.Origin origin) {
        return callIds.isEmpty() ? 0 : keptLines.remove(callIds, origin);
    }

    /** The call is in the live inbound list. */
    boolean isLiveCall(String callId) {
        return inboundCalls.getSummary(callId).isPresent();
    }

    List<String> callsWithKept(KeptLogLine.Origin origin, int limit) {
        return keptLines.callsWithKept(origin, limit);
    }

    private static KeptLogLine kept(String callId, LinkedLogLine l, KeptLogLine.Origin origin) {
        long at;
        try {
            at = Instant.parse(l.at()).toEpochMilli();
        } catch (RuntimeException e) {
            at = 0;
        }
        return new KeptLogLine(callId, l.sourceId(), l.sourceName(), l.lineId(), at, l.level(), l.thread(), l.logger(), l.message(),
                l.matchedBy() == null ? Match.THREAD_TIME.name() : l.matchedBy().name(), l.raw(), origin);
    }

    // ------------------------------------------------------------------ a line's call (US3)

    /**
     * The call a Logs-tab line was written during: the call its id field names (exact), else the call on the line's
     * thread whose window holds the line's time (the same nearest-middle rule). Only projects reading this source
     * with ▤ on are considered. Empty when no call fits.
     */
    public Optional<CallLogsModels.LineCall> forLine(String sourceId, String lineId) {
        LogLine line = null;
        for (ProjectLogSettings s : projectLogs.readingSource(sourceId)) {
            if (!capture.logsLinked(s.project())) {
                continue;
            }
            if (line == null) {
                line = logs.line(sourceId, lineId);
            }
            SourceContext ctx = context(sourceId, s);
            if (ctx == null) {
                continue;
            }
            Object tagged = ctx.hasCallId() ? line.fields().get(ctx.callIdField()) : null;
            if (tagged != null) {
                Optional<CallInfo> call = resolve(String.valueOf(tagged), null);
                if (call.isPresent()) {
                    return Optional.of(new CallLogsModels.LineCall(ref(call.get()), Match.EXACT));
                }
                continue; // tagged for a call Alfred no longer has: never time-matched to another one
            }
            Object thread = ctx.hasThread() ? line.fields().get(ctx.threadField()) : null;
            if (thread == null) {
                continue;
            }
            long at = line.ts();
            long skew = s.clockSkewMs();
            List<CallInfo> onThread = new ArrayList<>();
            // the calls opened on the line's thread last before its time (+ the clock difference): only they can hold it
            for (CallOnThread c : threads.callsBefore(String.valueOf(thread), Instant.ofEpochMilli(at + skew + 1), PREVIOUS_CALLS + 1)) {
                inboundCalls.getSummary(c.callId()).flatMap(CallLogsService::info).filter(i -> s.project().equals(i.project())).ifPresent(onThread::add);
            }
            List<Window> windows = onThread.stream().map(i -> new Window(i.id(), i.startMs(), i.endMs())).toList();
            for (CallInfo c : onThread) {
                Window self = new Window(c.id(), c.startMs(), c.endMs());
                if (CallWindows.belongsTo(self, windows, at, skew)) {
                    return Optional.of(new CallLogsModels.LineCall(ref(c), Match.THREAD_TIME));
                }
            }
        }
        return Optional.empty();
    }

    private static CallLogsModels.CallRef ref(CallInfo c) {
        return new CallLogsModels.CallRef(c.id(), c.method(), c.url(), c.status(), c.durationMs(), c.project(), Instant.ofEpochMilli(c.startMs()).toString());
    }

    /** True while the project's ▤ switch and its inbound logging are both on - only then are its logs read. */
    boolean linked(String project) {
        return capture.logsLinked(project);
    }

    // ------------------------------------------------------------------ the join

    /** A call and its window: the proxy's start time and duration (UTC epoch ms). */
    record CallInfo(String id, String project, long startMs, long durationMs, String method, String url, Integer status) {
        long endMs() {
            return startMs + durationMs;
        }
    }

    /** One matched line before it is read in full. {@code full} is filled for kept lines only. */
    record Hit(String sourceId, String sourceName, String lineId, long atMs, String level, Match match, KeptLogLine kept,
               SourceContext source, QueryLogsUseCase logs) {

        LinkedLogLine line(long callStartMs) {
            if (kept != null) {
                return new LinkedLogLine(sourceId, sourceName, lineId, Instant.ofEpochMilli(atMs).toString(), atMs - callStartMs, kept.level(),
                        kept.thread(), kept.logger(), kept.message(), match, true, kept.raw());
            }
            LogLine full = logs.line(sourceId, lineId);
            return new LinkedLogLine(sourceId, sourceName, lineId, Instant.ofEpochMilli(atMs).toString(), atMs - callStartMs, full.level(),
                    text(full.fields().get(source.threadField())), text(full.fields().get(source.loggerField())),
                    text(full.fields().get(source.messageField())), match, false, full.raw());
        }

        private static String text(Object v) {
            return v == null ? null : String.valueOf(v);
        }
    }

    /** What a source's structure says about the project's fields. */
    record SourceContext(String sourceId, String name, String threadField, String callIdField, String messageField, String loggerField,
                         boolean hasThread, boolean hasCallId) {
    }

    record Linked(Setup setup, Match match, String thread, int skewMs, List<Hit> hits) {
    }

    Linked link(CallInfo call) {
        List<Hit> kept = keptLines.kept(call.id()).stream().map(k -> new Hit(k.sourceId(), k.sourceName(), k.lineId(), k.atMs(),
                normalisedLevel(k.level()), "EXACT".equals(k.matchedBy()) ? Match.EXACT : Match.THREAD_TIME, k, null, logs)).toList();
        if (!capture.logsLinked(call.project())) {
            return new Linked(Setup.LINKING_OFF, matchOf(kept), null, 0, kept);
        }
        ProjectLogSettings settings = projectLogs.settings(call.project());
        if (settings.sourceIds().isEmpty()) {
            return new Linked(Setup.NO_SOURCE, matchOf(kept), null, settings.clockSkewMs(), kept);
        }
        List<SourceContext> sources = settings.sourceIds().stream().map(id -> context(id, settings)).filter(Objects::nonNull).toList();

        List<Hit> exact = new ArrayList<>();
        for (SourceContext s : sources) {
            if (s.hasCallId()) {
                exact.addAll(query(s, List.of(eq(s.callIdField(), call.id())), null, null, Match.EXACT));
            }
        }
        if (!exact.isEmpty()) {
            log.debug("call-logs {}: {} exact lines", call.id(), exact.size());
            return new Linked(Setup.OK, Match.EXACT, null, settings.clockSkewMs(), merge(exact, kept));
        }

        Optional<String> thread = sources.stream().anyMatch(SourceContext::hasThread) ? threads.requestThread(call.id()) : Optional.empty();
        if (thread.isEmpty()) {
            return new Linked(Setup.NO_THREAD, matchOf(kept), null, settings.clockSkewMs(), kept);
        }
        long skew = settings.clockSkewMs();
        Window self = new Window(call.id(), call.startMs(), call.endMs());
        List<Window> neighbours = neighbours(call, thread.get(), skew);
        List<Hit> byTime = new ArrayList<>();
        for (SourceContext s : sources) {
            if (!s.hasThread()) {
                continue;
            }
            List<LogQuery.Pill> pills = new ArrayList<>(List.of(eq(s.threadField(), thread.get())));
            if (s.hasCallId()) {
                // a line carrying any call's id is linked by that id only, never by time (FR-004)
                pills.add(new LogQuery.Pill(LogQuery.Op.NOT_EXISTS, s.callIdField(), null, null, null, null));
            }
            for (Hit h : query(s, pills, call.startMs() - skew, call.endMs() + skew, Match.THREAD_TIME)) {
                if (CallWindows.belongsTo(self, neighbours, h.atMs(), skew)) {
                    byTime.add(h);
                }
            }
        }
        log.debug("call-logs {}: {} thread-and-time lines on {} sources", call.id(), byTime.size(), sources.size());
        return new Linked(Setup.OK, Match.THREAD_TIME, thread.get(), settings.clockSkewMs(), merge(byTime, kept));
    }

    private static Match matchOf(List<Hit> hits) {
        return hits.isEmpty() ? null : hits.get(0).match();
    }

    /** Live lines and kept copies by line id, oldest first, at most {@link #MAX_LINES_PER_CALL}. */
    private static List<Hit> merge(List<Hit> live, List<Hit> kept) {
        Map<String, Hit> byLine = new LinkedHashMap<>();
        for (Hit h : live) {
            byLine.put(h.sourceId() + '|' + h.lineId(), h);
        }
        for (Hit h : kept) {
            byLine.putIfAbsent(h.sourceId() + '|' + h.lineId(), h);
        }
        return byLine.values().stream().sorted(Comparator.comparingLong(Hit::atMs).thenComparing(Hit::lineId))
                .limit(MAX_LINES_PER_CALL).toList();
    }

    private List<Window> neighbours(CallInfo call, String thread, long skew) {
        List<Window> out = new ArrayList<>();
        Instant from = Instant.ofEpochMilli(call.startMs() - skew);
        Instant to = Instant.ofEpochMilli(call.endMs() + skew);
        // A thread serves one request at a time: the calls opened inside this window, plus the last ones opened before
        // it (one of them may still have been running) - never a fixed look-back that a busy thread could overflow.
        Set<String> seen = new java.util.HashSet<>();
        List<CallOnThread> candidates = new ArrayList<>(threads.callsBefore(thread, from, PREVIOUS_CALLS));
        candidates.addAll(threads.callsOnThread(thread, from, to));
        for (CallOnThread other : candidates) {
            if (other.callId().equals(call.id()) || !seen.add(other.callId())) {
                continue;
            }
            inboundCalls.getSummary(other.callId()).flatMap(CallLogsService::info)
                    .ifPresent(o -> out.add(new Window(o.id(), o.startMs(), o.endMs())));
        }
        return out;
    }

    private SourceContext context(String sourceId, ProjectLogSettings settings) {
        LogStructure structure;
        String name;
        try {
            structure = logSources.structure(sourceId);
            name = logSources.get(sourceId).source().name();
        } catch (RuntimeException e) {
            log.warn("call-logs: log source {} is linked to {} but cannot be read: {}", sourceId, settings.project(), e.getMessage());
            return null;
        }
        // the fields by label or path, auto-detected when unset (WildFly writes "alfred.call" and "process.thread.name")
        String thread = ProjectLogFields.thread(structure, settings.threadField()).map(FieldDef::label).orElse(null);
        String callId = ProjectLogFields.callId(structure, settings.callIdField()).map(FieldDef::label).orElse(null);
        String message = structure.fields().stream().filter(f -> f.role() == Role.MESSAGE).map(FieldDef::label).findFirst().orElse("message");
        String logger = structure.fields().stream().filter(FieldDef::stored)
                .filter(f -> (f.path() == null ? f.label() : f.path()).toLowerCase(Locale.ROOT).endsWith("logger"))
                .map(FieldDef::label).sorted().findFirst().orElse(null);
        return new SourceContext(sourceId, name, thread, callId, message, logger, thread != null, callId != null);
    }

    /** One source's matching lines (summaries only), oldest first, paged through up to the per-call seatbelt. */
    private List<Hit> query(SourceContext s, List<LogQuery.Pill> pills, Long fromMs, Long toMs, Match match) {
        List<Hit> out = new ArrayList<>();
        String cursor = null;
        do {
            LogPage page = logs.lines(s.sourceId(), new LogQuery(pills, fromMs, toMs, new LogQuery.Sort(null, true), cursor, LogQuery.MAX_LIMIT));
            for (LogLineSummary line : page.lines()) {
                out.add(new Hit(s.sourceId(), s.name(), line.lineId(), line.ts(), normalisedLevel(line.level()), match, null, s, logs));
            }
            cursor = page.nextCursor();
        } while (cursor != null && out.size() < MAX_LINES_PER_CALL);
        return out;
    }

    private static LogQuery.Pill eq(String field, String value) {
        return new LogQuery.Pill(LogQuery.Op.EQ, field, value, null, null, null);
    }

    static String normalisedLevel(String level) {
        if (level == null) {
            return null;
        }
        String l = level.toUpperCase(Locale.ROOT);
        return switch (l) {
            case "WARNING" -> "WARN";
            case "FATAL", "SEVERE", "CRITICAL" -> "ERROR";
            default -> l;
        };
    }

    private static int offset(String after) {
        if (after == null || !after.startsWith(CURSOR)) {
            return 0;
        }
        try {
            return Math.max(0, Integer.parseInt(after.substring(CURSOR.length())));
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    // ------------------------------------------------------------------ resolving a call

    /** The live inbound call, else the cycle's copy (a cycle keeps calls the live list has dropped). */
    Optional<CallInfo> resolve(String callId, String cycleId) {
        if (callId == null || callId.isBlank()) {
            return Optional.empty();
        }
        Optional<CallInfo> live = inboundCalls.getSummary(callId).flatMap(CallLogsService::info);
        if (live.isPresent() || cycleId == null || cycleId.isBlank()) {
            return live;
        }
        return cycleCalls.listCalls(cycleId, new CallsQuery("", "", "oldest", 0, 50, "", "", callId))
                .flatMap(page -> page.calls().stream().filter(c -> c.call() != null && callId.equals(c.call().id())).findFirst())
                .flatMap(c -> info(c.call()));
    }

    /** The proxy writes "2026-10-06T00:17:44.891724+00:00"; older rows may be "...Z" or carry no zone (UTC). */
    static long epochMs(String timestamp) {
        try {
            return java.time.OffsetDateTime.parse(timestamp).toInstant().toEpochMilli();
        } catch (java.time.format.DateTimeParseException e) {
            return java.time.LocalDateTime.parse(timestamp).toInstant(java.time.ZoneOffset.UTC).toEpochMilli();
        }
    }

    static Optional<CallInfo> info(CallSummary s) {
        if (s == null || s.timestamp() == null) {
            return Optional.empty();
        }
        try {
            long start = epochMs(s.timestamp());
            long duration = s.durationMs() == null ? 0 : Math.round(s.durationMs());
            return Optional.of(new CallInfo(s.id(), s.serviceName(), start, duration, s.method(), s.url(), s.status()));
        } catch (RuntimeException e) {
            return Optional.empty();
        }
    }
}
