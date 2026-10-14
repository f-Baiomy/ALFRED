package com.fathy.alfred.backend.boardbridge;

import com.fathy.alfred.backend.board.domain.model.CycleCall;
import com.fathy.alfred.backend.dbcapture.application.port.in.CallLogLinesUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.GetCallDbSummariesUseCase;
import com.fathy.alfred.backend.dbcapture.domain.model.CallDbSummary;
import com.fathy.alfred.backend.dbcapture.domain.model.CaughtLogCounts;
import com.fathy.alfred.backend.internalcalls.application.port.in.GetCallsUseCase;
import com.fathy.alfred.backend.internalcalls.domain.model.CallSummary;
import com.fathy.alfred.backend.internalcalls.domain.model.CallsQuery;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListCapturedCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListPagedCapturedInternalCallsUseCase;
import com.fathy.alfred.backend.triagebridge.CycleCallsReader;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.Predicate;

/**
 * The calls a snippet or a query block reads (specs/017 R17, R18): inbound calls - live, or the ones a cycle captured -
 * narrowed by project, endpoint, time and signal, each as one compact row with what database capture and log catching
 * recorded for it (statements, writes, failed statements, database time, ERROR/WARN lines; null when not captured).
 * GET only, read-only, newest first; a snippet reaches it only through its host's allowlist.
 */
@RestController
public class BoardDataController {

    static final int DEFAULT_LIMIT = 200;
    static final int MAX_LIMIT = 1000;
    /** How many of the newest live calls are looked through to find the ones asked for. */
    static final int SCAN = 5000;
    private static final int PAGE = 500;

    /** One call, as a snippet gets it. */
    public record CallRow(String ref, String project, String method, String path, String endpoint, Integer status, String signal, Instant at,
                          Double durationMs, Integer statements, Integer writes, Integer failedStatements, Double dbMs, Integer errors,
                          Integer warnings) {
    }

    /** What to keep: all null/blank = everything. */
    record Filter(String project, String endpoint, Instant since, Instant until, String signal) {

        Predicate<CycleCall> calls() {
            String ep = endpoint == null ? "" : endpoint.strip().toLowerCase(Locale.ROOT);
            return c -> (ep.isEmpty() || matches(c, ep))
                    && (since == null || (c.at() != null && !c.at().isBefore(since)))
                    && (until == null || (c.at() != null && !c.at().isAfter(until)))
                    && (signal == null || signal.isBlank() || signal.equalsIgnoreCase(c.signal()));
        }

        /** `POST /fare` matches method and path start; anything else is a piece of the endpoint or path. */
        private static boolean matches(CycleCall c, String ep) {
            String endpoint = c.endpoint().toLowerCase(Locale.ROOT);
            String path = c.path() == null ? "" : c.path().toLowerCase(Locale.ROOT);
            int space = ep.indexOf(' ');
            if (space > 0 && ep.substring(0, space).matches("[a-z]+")) {
                String method = ep.substring(0, space);
                String rest = ep.substring(space + 1).strip();
                return c.method() != null && c.method().equalsIgnoreCase(method)
                        && (endpoint.contains(" " + rest) || path.startsWith(rest) || endpoint.contains(rest));
            }
            return endpoint.contains(ep) || path.contains(ep);
        }
    }

    private final GetCallsUseCase inbound;
    private final CycleCallsReader cycles;
    private final BoardCycleCallsAdapter signer;
    private final GetCallDbSummariesUseCase db;
    private final CallLogLinesUseCase logs;

    public BoardDataController(GetCallsUseCase inbound, ListCapturedCallsUseCase capturedCalls,
                               ListPagedCapturedInternalCallsUseCase capturedInternalCalls, BoardCycleCallsAdapter signer,
                               GetCallDbSummariesUseCase db, CallLogLinesUseCase logs) {
        this.inbound = inbound;
        this.cycles = new CycleCallsReader(capturedCalls, capturedInternalCalls);
        this.signer = signer;
        this.db = db;
        this.logs = logs;
    }

    @GetMapping("/board/data/calls")
    public ResponseEntity<?> calls(@RequestParam(required = false) String project, @RequestParam(required = false) String endpoint,
                                   @RequestParam(required = false) String since, @RequestParam(required = false) String until,
                                   @RequestParam(required = false) String cycle, @RequestParam(required = false) String signal,
                                   @RequestParam(required = false) Integer limit) {
        Instant from;
        Instant to;
        try {
            from = instant(since);
            to = instant(until);
        } catch (DateTimeParseException e) {
            return ResponseEntity.badRequest().body(Map.of("error", "invalid", "message", "since and until are ISO times, e.g. 2026-10-14T09:00:00Z"));
        }
        int max = limit == null ? DEFAULT_LIMIT : Math.max(1, Math.min(MAX_LIMIT, limit));
        Filter filter = new Filter(project, endpoint, from, to, signal);
        List<Signed> found = cycle == null || cycle.isBlank() ? live(filter, max) : captured(cycle.strip(), filter, max);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("calls", rows(found));
        out.put("truncated", found.size() >= max);
        return ResponseEntity.ok(out);
    }

    /** A signed call with the project it came to. */
    private record Signed(CycleCall call, String project) {
    }

    private List<Signed> live(Filter filter, int max) {
        List<Signed> out = new ArrayList<>();
        Predicate<CycleCall> keep = filter.calls();
        String services = filter.project() == null ? "" : filter.project().strip();
        try {
            for (int offset = 0; offset < SCAN && out.size() < max; offset += PAGE) {
                List<CallSummary> page = inbound.getCalls(new CallsQuery("", "", "newest", offset, PAGE, "", "", "", services)).calls();
                for (CallSummary c : page) {
                    CycleCall signed = sign(c);
                    if (filter.since() != null && signed.at() != null && signed.at().isBefore(filter.since())) {
                        return out; // newest first: everything after this is older still
                    }
                    if (keep.test(signed) && out.size() < max) {
                        out.add(new Signed(signed, c.serviceName()));
                    }
                }
                if (page.size() < PAGE) {
                    break;
                }
            }
        } catch (RuntimeException e) {
            return out;
        }
        return out;
    }

    private List<Signed> captured(String cycleId, Filter filter, int max) {
        List<Signed> out = new ArrayList<>();
        Predicate<CycleCall> keep = filter.calls();
        try {
            cycles.inbound(cycleId, c -> {
                if (c.call() == null || out.size() >= max) {
                    return;
                }
                CycleCall signed = sign(c.call());
                CycleCall ref = new CycleCall(signed.direction(), signed.callId() + "@" + cycleId, signed.method(), signed.path(), signed.status(),
                        signed.signature(), signed.at(), signed.durationMs());
                if ((filter.project() == null || filter.project().isBlank() || filter.project().equalsIgnoreCase(c.call().serviceName()))
                        && keep.test(signed)) {
                    out.add(new Signed(ref, c.call().serviceName()));
                }
            });
        } catch (RuntimeException e) {
            return out;
        }
        out.sort((a, b) -> b.call().at() == null || a.call().at() == null ? 0 : b.call().at().compareTo(a.call().at()));
        return out;
    }

    private CycleCall sign(CallSummary c) {
        CycleCall s = signer.call("in", c.id(), c.method(), c.url(), c.status());
        return new CycleCall(s.direction(), s.callId(), s.method(), s.path(), s.status(), s.signature(), BoardCycleCallsAdapter.instant(c.timestamp()),
                c.durationMs());
    }

    private List<CallRow> rows(List<Signed> calls) {
        List<String> ids = calls.stream().map(s -> bareId(s.call().callId())).distinct().toList();
        Map<String, CallDbSummary> summaries = Map.of();
        Map<String, CaughtLogCounts> counts = Map.of();
        try {
            summaries = ids.isEmpty() ? Map.of() : db.summaries(ids);
        } catch (RuntimeException ignored) {
            // database capture unreadable: statements stay unknown
        }
        try {
            counts = ids.isEmpty() ? Map.of() : logs.counts(ids);
        } catch (RuntimeException ignored) {
            // log catching unreadable: lines stay unknown
        }
        List<CallRow> out = new ArrayList<>(calls.size());
        for (Signed s : calls) {
            CycleCall c = s.call();
            String id = bareId(c.callId());
            CallDbSummary d = summaries.get(id);
            CaughtLogCounts l = counts.get(id);
            out.add(new CallRow("in:" + c.callId(), s.project(), c.method(), c.path(), c.endpoint(), c.status(), c.signal(), c.at(), c.durationMs(),
                    d == null ? null : d.statementCount(), d == null ? null : d.writeCount(), d == null ? null : d.failedCount(),
                    d == null ? null : d.dbMicros() / 1000.0, l == null ? null : l.errors(), l == null ? null : l.warnings()));
        }
        return out;
    }

    private static String bareId(String callId) {
        int at = callId.indexOf('@');
        return at < 0 ? callId : callId.substring(0, at);
    }

    static Instant instant(String s) {
        return s == null || s.isBlank() ? null : Instant.parse(s.strip());
    }
}
