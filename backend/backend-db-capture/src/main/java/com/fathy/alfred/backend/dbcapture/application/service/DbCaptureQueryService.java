package com.fathy.alfred.backend.dbcapture.application.service;

import com.fathy.alfred.backend.dbcapture.domain.DeadlineCharSequence;
import com.fathy.alfred.backend.dbcapture.domain.LogLevels;
import com.fathy.alfred.backend.dbcapture.domain.model.LogSearchPage;
import com.fathy.alfred.backend.dbcapture.domain.model.LogSearchQuery;
import com.fathy.alfred.backend.dbcapture.domain.model.LogProblemCall;
import com.fathy.alfred.backend.dbcapture.application.port.in.CallLogLinesUseCase;
import com.fathy.alfred.backend.dbcapture.domain.model.CaughtLogCounts;
import com.fathy.alfred.backend.dbcapture.domain.model.CaughtLogLine;
import com.fathy.alfred.backend.dbcapture.application.port.in.CallThreadsUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.ExportCallStatementsUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.FindStatementFailuresUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.GetCallDbSummariesUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.GetCallStatementsUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.GetStatementUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.IngestStatementsUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureStorePort;
import com.fathy.alfred.backend.dbcapture.domain.model.CallDbCaptureExport;
import com.fathy.alfred.backend.dbcapture.domain.model.CallDbSummary;
import com.fathy.alfred.backend.dbcapture.domain.model.CallMarker;
import com.fathy.alfred.backend.dbcapture.domain.model.CallOnThread;
import com.fathy.alfred.backend.dbcapture.domain.model.CallStatementFailures;
import com.fathy.alfred.backend.dbcapture.domain.model.CallStatementsPage;
import com.fathy.alfred.backend.dbcapture.domain.model.CapturedStatement;
import com.fathy.alfred.backend.dbcapture.domain.model.ExportedStatement;
import com.fathy.alfred.backend.dbcapture.domain.model.FailureCounts;
import com.fathy.alfred.backend.dbcapture.domain.model.IncomingStatement;
import com.fathy.alfred.backend.dbcapture.domain.model.IngestBatch;
import com.fathy.alfred.backend.dbcapture.domain.model.MarkerType;
import com.fathy.alfred.backend.dbcapture.domain.model.RowsPage;
import com.fathy.alfred.backend.dbcapture.domain.model.StatementOutcome;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.regex.PatternSyntaxException;
import java.util.regex.Pattern;
import java.util.Collection;
import java.util.Map;
import java.util.Optional;

/** Reads for the ◆ DB chip and the database window. Every size the client asks for is clamped here. */
@Service
public class DbCaptureQueryService implements GetCallDbSummariesUseCase, GetCallStatementsUseCase, GetStatementUseCase, CallThreadsUseCase, CallLogLinesUseCase,
        ExportCallStatementsUseCase, FindStatementFailuresUseCase {

    static final String RESULT = "RESULT";
    static final String BEFORE_IMAGE = "BEFORE_IMAGE";

    static final String IMPORT_AGENT = "import";

    private final DbCaptureStorePort store;
    private final IngestStatementsUseCase ingest;
    /** Redis commands travel with the call's export (specs/011-redis-capture FR-030). Optional for tests built before it. */
    private StoreCommandsService storeCommands;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    void setStoreCommands(StoreCommandsService storeCommands) {
        this.storeCommands = storeCommands;
    }

    public DbCaptureQueryService(DbCaptureStorePort store, IngestStatementsUseCase ingest) {
        this.store = store;
        this.ingest = ingest;
    }

    // ---- caught log lines (specs/009-agent-log-capture)

    /** Imported calls hand their signals on like recorded ones (FR-018). Optional for tests. */
    private CallSignalsPublisher signals;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    void setSignals(CallSignalsPublisher signals) {
        this.signals = signals;
    }

    @Override
    public boolean caughtFor(String callId) {
        return callId != null && !callId.isBlank() && store.catchesLogs(callId);
    }

    @Override
    public List<CaughtLogLine> lines(String callId, int afterSeq, int limit) {
        if (callId == null || callId.isBlank()) {
            return List.of();
        }
        return store.logLines(callId, Math.max(-1, afterSeq), clampLogLimit(limit));
    }

    @Override
    public void importLines(String callId, List<CaughtLogLine> lines) {
        if (callId == null || callId.isBlank() || lines == null || lines.isEmpty()) {
            return;
        }
        store.deleteLogLines(callId); // importing the same call again replaces its lines
        store.saveLogLines(lines.stream().map(l -> new CaughtLogLine(0, callId, l.seq(), l.at(), l.level(), l.logger(), l.thread(), l.message(),
                l.exceptionType(), l.exceptionMessage(), l.exceptionStack(), l.cut(), l.project())).limit(5_000).toList());
        if (signals != null) {
            signals.publish(List.of(callId));
        }
    }

    @Override
    public Map<String, CaughtLogCounts> counts(List<String> callIds) {
        return callIds == null || callIds.isEmpty() ? Map.of() : store.logCounts(callIds.stream().limit(1000).toList());
    }

    @Override
    public List<CaughtLogLine> outside(String project, String thread, long afterId, int limit) {
        return store.outsideLogLines(project, thread, Math.max(0, afterId), clampLogLimit(limit));
    }

    // ------------------------------------------------------------------ cross-call log reads (specs/010)

    @Override
    public LogSearchPage search(Collection<String> scope, LogSearchQuery query) {
        if (query.text() != null && query.text().length() > LogSearchQuery.MAX_TEXT) {
            throw new IllegalArgumentException("text is limited to " + LogSearchQuery.MAX_TEXT + " characters");
        }
        LogLevels.atOrAbove(query.minLevel()); // an unknown level is refused before any read
        if (query.pattern() == null || query.pattern().isBlank()) {
            return store.searchLogLines(scope, query);
        }
        if (query.pattern().length() > LogSearchQuery.MAX_PATTERN) {
            throw new IllegalArgumentException("pattern is limited to " + LogSearchQuery.MAX_PATTERN + " characters");
        }
        Pattern pattern;
        try {
            pattern = Pattern.compile(query.pattern(), Pattern.CASE_INSENSITIVE);
        } catch (PatternSyntaxException e) {
            throw new IllegalArgumentException("not a valid pattern: " + e.getDescription());
        }
        return patternSearch(scope, query, pattern);
    }

    /**
     * A pattern narrows through the text index by its longest literal run, then each candidate is matched in Java over
     * a deadline-checking text - 2 s and 200,000 candidates at most, said in {@code cutShort} (research R3).
     */
    private LogSearchPage patternSearch(Collection<String> scope, LogSearchQuery query, Pattern pattern) {
        String literal = longestLiteral(query.pattern());
        long deadline = System.nanoTime() + PATTERN_BUDGET_MS * 1_000_000L;
        List<CaughtLogLine> page = new ArrayList<>();
        long total = 0;
        long scanned = 0;
        Long before = query.beforeId();
        Long next = null;
        String reason = null;
        scan:
        while (true) {
            List<CaughtLogLine> batch = store.logCandidates(scope, query, literal, before, 1_000);
            if (batch.isEmpty()) {
                break;
            }
            for (CaughtLogLine line : batch) {
                if (scanned >= PATTERN_MAX_CANDIDATES) {
                    reason = "CANDIDATES";
                    break scan;
                }
                scanned++;
                boolean hit;
                try {
                    hit = pattern.matcher(new DeadlineCharSequence(searchText(line), deadline)).find();
                } catch (DeadlineCharSequence.Expired e) {
                    reason = "TIME";
                    break scan;
                }
                if (hit) {
                    total++;
                    if (page.size() < query.limit()) {
                        page.add(line);
                    } else if (next == null) {
                        next = page.get(page.size() - 1).id();
                    }
                }
                if (System.nanoTime() > deadline) {
                    reason = "TIME";
                    break scan;
                }
            }
            before = batch.get(batch.size() - 1).id();
        }
        return new LogSearchPage(total, List.copyOf(page), next, reason == null ? null : new LogSearchPage.CutShort(scanned, reason));
    }

    private static String searchText(CaughtLogLine l) {
        return String.join("\n", Optional.ofNullable(l.message()).orElse(""), Optional.ofNullable(l.logger()).orElse(""),
                Optional.ofNullable(l.thread()).orElse(""), Optional.ofNullable(l.exceptionType()).orElse(""),
                Optional.ofNullable(l.exceptionMessage()).orElse(""));
    }

    /** The longest run of plain characters in a regex - what the text index can look for first; null when under 3. */
    static String longestLiteral(String regex) {
        String best = "";
        StringBuilder run = new StringBuilder();
        for (int i = 0; i < regex.length(); i++) {
            char c = regex.charAt(i);
            boolean quantified = i + 1 < regex.length() && "*?{".indexOf(regex.charAt(i + 1)) >= 0;
            if (c == '\\' || "^$.|?*+()[]{}".indexOf(c) >= 0 || quantified) {
                if (run.length() > best.length()) {
                    best = run.toString();
                }
                run.setLength(0);
                if (c == '\\') {
                    i++; // an escape: \d, \w or an escaped character - never part of a literal run
                }
                continue;
            }
            run.append(c);
        }
        if (run.length() > best.length()) {
            best = run.toString();
        }
        return best.length() >= 3 ? best : null;
    }

    @Override
    public LogProblemsPage problems(Collection<String> scope, boolean withWarnings, Long fromMs, Long toMs, int limit) {
        List<String> levels = withWarnings ? List.of("ERROR", "WARN") : List.of("ERROR");
        int clamped = limit <= 0 ? 30 : Math.min(limit, MAX_PROBLEMS);
        return new LogProblemsPage(store.logProblems(scope, levels, fromMs, toMs, clamped), store.logProblemCount(scope, levels, fromMs, toMs));
    }

    @Override
    public List<LogProblemCall> problemCalls(Collection<String> scope, String fingerprint, int offset, int limit) {
        if (fingerprint == null || !fingerprint.matches("[0-9a-f]{16}")) {
            throw new IllegalArgumentException("fingerprint must be the 16 hex characters log_problems gives");
        }
        return store.logProblemCalls(scope, fingerprint, offset, limit <= 0 ? 50 : Math.min(limit, 200));
    }

    @Override
    public List<CaughtLogLine> outside(String project, String thread, long afterId, int limit, Long fromMs, Long toMs, String minLevel) {
        return store.outsideLogLines(project, thread, Math.max(0, afterId), clampLogLimit(limit), fromMs, toMs, LogLevels.atOrAbove(minLevel));
    }

    @Override
    public Optional<String> capturedLevel(String callId) {
        return callId == null || callId.isBlank() ? Optional.empty() : store.callLogLevel(callId);
    }

    private static int clampLogLimit(int limit) {
        return limit <= 0 ? 200 : Math.min(limit, CallLogLinesUseCase.MAX_PAGE);
    }

    @Override
    public Map<String, CallDbSummary> summaries(List<String> callIds) {
        List<String> ids = callIds.stream().filter(id -> id != null && !id.isBlank()).distinct().limit(GetCallDbSummariesUseCase.MAX_IDS).toList();
        if (ids.isEmpty()) {
            return Map.of();
        }
        // Calls flagged by older rules get the current ones on their first read - no new capture needed.
        store.withStaleFlags(ids).forEach(id -> DbCaptureFlagsListener.reflag(store, id));
        return store.summaries(ids);
    }

    @Override
    public Map<String, String> silentCalls(List<String> callIds) {
        List<String> ids = callIds.stream().filter(id -> id != null && !id.isBlank()).distinct().limit(GetCallDbSummariesUseCase.MAX_IDS).toList();
        if (ids.isEmpty()) {
            return Map.of();
        }
        return store.silentCalls(ids, java.time.Instant.now().minusSeconds(GetCallDbSummariesUseCase.SILENT_AFTER_SECONDS).toString());
    }

    @Override
    public Map<String, CallStatementFailures> failures(List<String> callIds) {
        List<String> ids = callIds.stream().filter(id -> id != null && !id.isBlank()).distinct().toList();
        if (ids.size() > FindStatementFailuresUseCase.MAX_IDS) {
            throw new IllegalArgumentException("At most " + FindStatementFailuresUseCase.MAX_IDS + " call ids per request, got " + ids.size());
        }
        if (ids.isEmpty()) {
            return Map.of();
        }
        Map<String, CallStatementFailures> result = new LinkedHashMap<>();
        store.failedStatements(ids, CallStatementFailures.MAX_PER_CALL).forEach((callId, statements) -> {
            List<CallStatementFailures.FailedStatement> failed = statements.stream().map(CallStatementFailures.FailedStatement::of).toList();
            // Under the cap the list is the whole story; at the cap the counts come from the index.
            FailureCounts counts = statements.size() < CallStatementFailures.MAX_PER_CALL
                    ? new FailureCounts(failed.size(), (int) failed.stream().filter(CallStatementFailures.FailedStatement::swallowed).count())
                    : store.failureCounts(callId);
            result.put(callId, new CallStatementFailures(callId, counts.failed(), counts.swallowed(), failed));
        });
        return result;
    }

    @Override
    public CallStatementsPage statements(String callId, int afterSeq, int limit) {
        int clamped = clamp(limit, 1, MAX_LIMIT);
        List<CapturedStatement> page = store.statementsAfter(callId, Math.max(-1, afterSeq), clamped + 1);
        boolean hasMore = page.size() > clamped;
        List<CapturedStatement> statements = hasMore ? page.subList(0, clamped) : page;
        // Markers are few per call; the window needs every supplier position, not only those after afterSeq.
        List<CallMarker> supplierMarkers = store.markers(callId).stream().filter(m -> m.type() == MarkerType.HTTP_OUT).toList();
        return new CallStatementsPage(statements, store.transactions(callId), supplierMarkers, hasMore);
    }

    @Override
    public CallStatementsPage outside(String thread, int offset, int limit) {
        int clamped = clamp(limit, 1, MAX_LIMIT);
        List<CapturedStatement> page = store.outsideStatements(thread, Math.max(0, offset), clamped + 1);
        boolean hasMore = page.size() > clamped;
        return new CallStatementsPage(hasMore ? page.subList(0, clamped) : page, List.of(), List.of(), hasMore);
    }

    @Override
    public Optional<CapturedStatement> statement(long id) {
        return store.statement(id);
    }

    @Override
    public Optional<RowsPage> rows(long id, String part, int offset, int limit) {
        String safePart = BEFORE_IMAGE.equals(part) ? BEFORE_IMAGE : RESULT;
        return store.statement(id).map(statement -> {
            StatementOutcome outcome = statement.outcome();
            boolean result = RESULT.equals(safePart);
            return new RowsPage(store.columns(id, safePart), store.rows(id, safePart, Math.max(0, offset), clamp(limit, 1, MAX_ROWS)),
                    store.rowCount(id, safePart), result ? outcome.rowsRead() : null, result ? outcome.partial() : null,
                    result ? outcome.overLimit() : null);
        });
    }

    @Override
    public Optional<String> requestThread(String callId) {
        return callId == null || callId.isBlank() ? Optional.empty() : store.requestThread(callId);
    }

    @Override
    public List<CallOnThread> callsOnThread(String thread, Instant from, Instant to) {
        if (thread == null || thread.isBlank() || from == null || to == null || to.isBefore(from)) {
            return List.of();
        }
        return store.callsOnThread(thread, from.toString(), to.toString());
    }

    @Override
    public List<CallOnThread> callsBefore(String thread, Instant before, int limit) {
        if (thread == null || thread.isBlank() || before == null || limit <= 0) {
            return List.of();
        }
        return store.callsBefore(thread, before.toString(), Math.min(limit, 50));
    }

    @Override
    public Optional<CallDbCaptureExport> export(String callId) {
        Optional<CallDbSummary> summary = store.summary(callId);
        Optional<com.fathy.alfred.backend.dbcapture.domain.model.CallStoreSummary> redisSummary =
                storeCommands == null ? Optional.empty() : storeCommands.summary(callId);
        if (summary.isEmpty()) {
            // a call with only Redis commands recorded (⬢ on, ◆ off) still exports them
            return redisSummary.map(rs -> new CallDbCaptureExport(null, List.of(), List.of(), List.of(), storeCommands.export(callId), rs));
        }
        List<ExportedStatement> statements = store.allStatements(callId, Integer.MAX_VALUE).stream()
                .map(s -> ExportedStatement.of(s,
                        s.storedRows() > 0 ? store.rows(s.id(), RESULT, 0, Integer.MAX_VALUE) : List.of(),
                        s.beforeImage() != null ? store.rows(s.id(), BEFORE_IMAGE, 0, Integer.MAX_VALUE) : List.of()))
                .toList();
        List<CallMarker> supplierMarkers = store.markers(callId).stream().filter(m -> m.type() == MarkerType.HTTP_OUT).toList();
        return Optional.of(new CallDbCaptureExport(summary.get(), store.transactions(callId), supplierMarkers, statements,
                redisSummary.isPresent() ? storeCommands.export(callId) : null, redisSummary.orElse(null)));
    }

    /**
     * Re-import goes through the same ingest as the agent - transactions and the summary are recomputed from the
     * statements, never trusted from the file. Statement ids are re-assigned; the sid ("import:callId:seq") makes a
     * second import of the same file a no-op.
     */
    @Override
    public int importCaptures(Map<String, CallDbCaptureExport> byCallId) {
        int stored = 0;
        for (Map.Entry<String, CallDbCaptureExport> entry : byCallId.entrySet()) {
            String callId = entry.getKey();
            CallDbCaptureExport capture = entry.getValue();
            if (callId == null || callId.isBlank() || capture == null) {
                continue;
            }
            List<IncomingStatement> statements = new ArrayList<>();
            for (ExportedStatement s : capture.statements() == null ? List.<ExportedStatement>of() : capture.statements()) {
                statements.add(new IncomingStatement(IMPORT_AGENT + ":" + callId + ":" + s.seq(), callId, s.runTag(), s.thread(), s.seq(),
                        s.kind(), s.sql(), s.fingerprint(), s.table(), s.params(), s.outcome(), s.rows(), 0, s.beforeImageRows(),
                        s.beforeImage(), s.startedAt(), s.durationMicros(), s.offsetMicros(), s.txId(), s.connectionId(),
                        s.codeLocation(), s.dataSource(), s.cascadesTo(), s.origin(), s.callers(), s.indexes()));
            }
            List<CallMarker> markers = new ArrayList<>();
            markers.add(new CallMarker(callId, 0, MarkerType.CALL_OPEN, null, null, null));
            for (CallMarker m : capture.supplierMarkers() == null ? List.<CallMarker>of() : capture.supplierMarkers()) {
                markers.add(new CallMarker(callId, m.seq(), MarkerType.HTTP_OUT, m.at(), m.method(), m.url()));
            }
            List<IngestBatch.RedisIn> redis = new ArrayList<>();
            for (var r : capture.redis() == null ? List.<com.fathy.alfred.backend.dbcapture.domain.model.ExportedStoreCommand>of() : capture.redis()) {
                if (r != null) {
                    redis.add(StoreCommandsService.imported(callId, r));
                }
            }
            if (capture.redisSummary() != null || !redis.isEmpty()) {
                markers.set(0, new CallMarker(callId, 0, MarkerType.CALL_OPEN, null, null, null, null, null, null, Boolean.TRUE));
            }
            stored += ingest.ingest(new IngestBatch(IMPORT_AGENT, null, statements, markers, Map.of(), List.of(), Map.of(), redis, List.of(),
                    Map.of())).accepted();
            store.markComplete(callId, capture.summary() != null && capture.summary().endedEarly());
            if (storeCommands != null && (capture.redisSummary() != null || !redis.isEmpty())) {
                storeCommands.callCompleted(callId, capture.redisSummary() != null && capture.redisSummary().endedEarly());
            }
        }
        return stored;
    }

    static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }
}
