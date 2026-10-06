package com.fathy.alfred.backend.calllogsbridge;

import com.fathy.alfred.backend.calllogsbridge.CallLogsModels.CallLogsPage;
import com.fathy.alfred.backend.calllogsbridge.CallLogsModels.LinkedLogLine;
import com.fathy.alfred.backend.calllogsbridge.CallLogsModels.LogCounts;
import com.fathy.alfred.backend.calllogsbridge.CallLogsModels.Match;
import com.fathy.alfred.backend.calllogsbridge.CallLogsModels.Setup;
import com.fathy.alfred.backend.dbcapture.application.port.in.CallLogLinesUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.ManageDbCaptureUseCase;
import com.fathy.alfred.backend.dbcapture.domain.model.CaughtLogCounts;
import com.fathy.alfred.backend.dbcapture.domain.model.CaughtLogLine;
import com.fathy.alfred.backend.internalcalls.application.port.in.GetCallDetailUseCase;
import com.fathy.alfred.backend.internalcalls.domain.model.CallSummary;
import com.fathy.alfred.backend.internalcalls.domain.model.CallsQuery;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListCapturedInternalCallsUseCase;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * A call's log lines (specs/009-agent-log-capture): the lines the db-agent caught inside the application while it
 * handled the call, stored with the call's statements - nothing is read from log files or the Logs tab. The ▤ switch
 * (per project) turns the agent's catching on; a call recorded while it was off, or before the new agent was loaded,
 * has no lines. Lines of an imported call (.json export) are stored the same way. Logs ids and counts only.
 */
@Service
public class CallLogsService {

    private static final Logger log = LoggerFactory.getLogger(CallLogsService.class);

    static final int MAX_PAGE = 500;
    static final int DEFAULT_PAGE = 200;
    /** Lines kept per imported call - the agent's own per-call cap. */
    static final int MAX_IMPORTED_LINES = 5_000;
    private static final String SEQ_CURSOR = "s:";
    private static final com.fasterxml.jackson.databind.ObjectMapper JSON = new com.fasterxml.jackson.databind.ObjectMapper();

    private final ManageDbCaptureUseCase capture;
    private final GetCallDetailUseCase inboundCalls;
    private final ListCapturedInternalCallsUseCase cycleCalls;
    private final CallLogLinesUseCase caught;

    public CallLogsService(ManageDbCaptureUseCase capture, GetCallDetailUseCase inboundCalls, ListCapturedInternalCallsUseCase cycleCalls,
                           CallLogLinesUseCase caught) {
        this.capture = capture;
        this.inboundCalls = inboundCalls;
        this.cycleCalls = cycleCalls;
        this.caught = caught;
    }

    // ------------------------------------------------------------------ a call's lines

    /** The project's Log level now (ERROR by default; APP = the application's own) - lines below it were not caught. */
    private String logLevel(String project) {
        try {
            return project == null ? null : capture.settings(project).logLevel();
        } catch (RuntimeException e) {
            return null;
        }
    }

    /** The call's caught lines in its own order (seq), one page. Empty when the call is unknown. */
    public Optional<CallLogsPage> lines(String callId, String cycleId, String after, int limit) {
        return resolve(callId, cycleId).map(call -> {
            if (!caught.caughtFor(call.id())) {
                // nothing was caught for it: say why - ▤ off for its project, or the agent did not catch (not loaded / old)
                Setup why = capture.logsLinked(call.project()) ? Setup.NO_AGENT : Setup.LINKING_OFF;
                return new CallLogsPage(call.id(), why, null, null, 0, List.of(), null, 0);
            }
            int size = limit <= 0 ? DEFAULT_PAGE : Math.min(limit, MAX_PAGE);
            int afterSeq = after != null && after.startsWith(SEQ_CURSOR) ? parseInt(after.substring(SEQ_CURSOR.length())) : -1;
            List<CaughtLogLine> page = caught.lines(call.id(), afterSeq, size);
            List<LinkedLogLine> lines = page.stream().map(l -> caughtLine(call, l)).toList();
            String next = page.size() == size ? SEQ_CURSOR + page.get(page.size() - 1).seq() : null;
            CaughtLogCounts counts = caught.counts(List.of(call.id())).get(call.id());
            return new CallLogsPage(call.id(), Setup.OK, Match.CAUGHT, null, 0, lines, next, counts == null ? 0 : counts.dropped(),
                    logLevel(call.project()));
        });
    }

    /** Counts per call from what was stored as the lines arrived - no line is read (FR-013). Calls without lines are left out. */
    public Map<String, LogCounts> counts(List<String> callIds) {
        Map<String, LogCounts> out = new LinkedHashMap<>();
        if (callIds.isEmpty()) {
            return out;
        }
        caught.counts(callIds).forEach((id, c) -> {
            if (c.lines() > 0) {
                out.put(id, new LogCounts(c.lines(), c.errors(), c.warnings(), Match.CAUGHT));
            }
        });
        return out;
    }

    /** An imported call's lines (.json export), stored with the call like caught lines; returns how many were kept. */
    public int importLines(String callId, List<LinkedLogLine> lines) {
        List<CaughtLogLine> stored = new ArrayList<>();
        int seq = 1;
        for (LinkedLogLine l : lines) {
            if (stored.size() >= MAX_IMPORTED_LINES) {
                break;
            }
            CallLogsModels.LogException ex = l.exception();
            stored.add(new CaughtLogLine(0, callId, l.seq() != null ? l.seq() : seq, l.at(), l.level(), l.logger(), l.thread(), l.message(),
                    ex == null ? null : ex.type(), ex == null ? null : ex.message(), ex == null ? null : ex.stack(), false, null));
            seq++;
        }
        caught.importLines(callId, stored);
        log.debug("call-logs {}: {} imported lines stored", callId, stored.size());
        return stored.size();
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

    // ------------------------------------------------------------------ resolving a call

    /** A call and its start (the proxy's timestamp) - the lines' offsets are measured from it. */
    record CallInfo(String id, String project, long startMs, long durationMs, String method, String url, Integer status) {
    }

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
