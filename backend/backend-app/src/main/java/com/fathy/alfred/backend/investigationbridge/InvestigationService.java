package com.fathy.alfred.backend.investigationbridge;

import com.fathy.alfred.backend.dbcapture.application.port.in.CallLogLinesUseCase;
import com.fathy.alfred.backend.dbcapture.domain.model.CaughtLogLine;
import com.fathy.alfred.backend.dbcapture.domain.model.LogProblem;
import com.fathy.alfred.backend.dbcapture.domain.model.LogProblemCall;
import com.fathy.alfred.backend.dbcapture.domain.model.LogSearchPage;
import com.fathy.alfred.backend.dbcapture.domain.model.LogSearchQuery;
import com.fathy.alfred.backend.investigationbridge.InvestigationModels.EndpointsRequest;
import com.fathy.alfred.backend.investigationbridge.InvestigationModels.LogProblemCallsRequest;
import com.fathy.alfred.backend.investigationbridge.InvestigationModels.LogProblemsRequest;
import com.fathy.alfred.backend.investigationbridge.InvestigationModels.LogSearchRequest;
import com.fathy.alfred.backend.investigationbridge.InvestigationModels.ProblemCallsRequest;
import com.fathy.alfred.backend.investigationbridge.InvestigationModels.ResolvedScope;
import com.fathy.alfred.backend.investigationbridge.InvestigationModels.ScopeCall;
import com.fathy.alfred.backend.investigationbridge.InvestigationModels.TimelineRequest;
import com.fathy.alfred.backend.triage.application.port.in.AnalyseCallsUseCase;
import com.fathy.alfred.backend.triage.domain.EndpointPattern;
import com.fathy.alfred.backend.triage.domain.model.CallAttention;
import com.fathy.alfred.backend.triage.domain.model.ProblemCall;
import com.fathy.alfred.backend.triage.domain.model.ProblemCallsPage;
import com.fathy.alfred.backend.triage.domain.model.ProblemFilter;
import com.fathy.alfred.backend.triage.domain.model.Signal;
import com.fathy.alfred.backend.triage.domain.model.SignalTimeline;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * The cross-call investigation answers (specs/010-mcp-log-investigation, contracts/investigate-api.md): a scope is
 * resolved once, then triage's marks or db-capture's caught lines answer over it. Lives in backend-app because it reads
 * three slices (session cycles and internal calls for the scope, triage, db-capture) that may not know each other.
 */
@Service
public class InvestigationService {

    private final ScopeResolver scopes;
    private final AnalyseCallsUseCase analysis;
    private final CallLogLinesUseCase logs;

    public InvestigationService(ScopeResolver scopes, AnalyseCallsUseCase analysis, CallLogLinesUseCase logs) {
        this.scopes = scopes;
        this.analysis = analysis;
        this.logs = logs;
    }

    private static Map<String, Object> answer(ResolvedScope scope) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("scope", scope.info());
        out.put("unavailable", scope.unavailable());
        return out;
    }

    private static Set<Signal> signals(List<String> names) {
        Set<Signal> out = EnumSet.noneOf(Signal.class);
        for (String name : names == null ? List.<String>of() : names) {
            try {
                out.add(Signal.valueOf(name.strip().toUpperCase(Locale.ROOT)));
            } catch (IllegalArgumentException e) {
                throw new IllegalArgumentException("unknown signal " + name + " - one of " + List.of(Signal.values()));
            }
        }
        return out;
    }

    // ------------------------------------------------------------------ triage's marks

    public Map<String, Object> problemCalls(ProblemCallsRequest r) {
        ResolvedScope scope = scopes.resolve(r.scope(), r.project(), r.from(), r.to());
        ProblemFilter filter = new ProblemFilter(signals(r.all()), signals(r.any()), signals(r.none()), r.dbFlags(),
                r.minStatus() == null ? 0 : r.minStatus(), null, null, null);
        ProblemCallsPage page = analysis.problemCalls(scope.ids(), filter, r.offset() == null ? 0 : r.offset(), r.limit() == null ? 50 : r.limit());
        Map<String, Object> counts = new LinkedHashMap<>();
        page.counts().forEach((signal, n) -> counts.put(signal.name(), n));
        counts.put("total", page.total());
        Map<String, Object> out = answer(scope);
        out.put("counts", counts);
        out.put("matching", page.matching());
        if (page.total() < scope.calls().size()) {
            out.put("unmarked", scope.calls().size() - page.total()); // calls triage has no mark for (yet)
        }
        out.put("calls", page.calls().stream().map(p -> problemCall(p, scope.calls().get(p.call().callId()))).toList());
        out.put("next", page.nextOffset());
        return out;
    }

    private static Map<String, Object> problemCall(ProblemCall p, ScopeCall call) {
        CallAttention mark = p.call();
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("callId", mark.callId());
        row.put("method", mark.method());
        row.put("path", call == null ? mark.url() : call.path());
        row.put("status", mark.status());
        if (mark.error() != null) {
            row.put("error", mark.error());
        }
        row.put("startedAt", Instant.ofEpochMilli(mark.startedAt()).toString());
        row.put("durationMs", mark.durationMs());
        row.put("project", mark.project());
        row.put("heldIn", call == null ? List.of() : call.heldIn());
        row.put("signals", p.signals());
        row.put("severity", p.severity());
        Map<String, Object> evidence = new LinkedHashMap<>();
        evidence.put("failedStatements", mark.failedStatements());
        evidence.put("swallowed", mark.swallowedStatements() > 0);
        evidence.put("dbFlags", mark.signals().dbFlags());
        evidence.put("logErrors", mark.signals().logErrors());
        evidence.put("logWarnings", mark.signals().logWarnings());
        evidence.put("logExceptions", mark.signals().logExceptions());
        evidence.put("failingSupplierCalls", mark.failingChildren());
        evidence.put("logStatus", mark.signals().logStatus());
        evidence.put("logLevel", mark.signals().logLevel());
        evidence.put("redisFailed", mark.signals().redisFailed());
        evidence.put("cacheCold", mark.signals().redisCold());
        row.put("evidence", evidence);
        return row;
    }

    public Map<String, Object> endpoints(EndpointsRequest r) {
        ResolvedScope scope = scopes.resolve(r.scope(), r.project(), r.from(), r.to());
        Map<String, Object> out = answer(scope);
        List<com.fathy.alfred.backend.triage.domain.model.EndpointHealth> health =
                analysis.endpoints(scope.ids(), null, null, null, r.limit() == null ? 50 : r.limit());
        out.put("endpoints", redis == null ? health : withRedis(health, scope));
        return out;
    }

    /** Redis per endpoint (specs/011-redis-capture FR-034): commands per call, hit rate, misses filled per call, failed calls. */
    private com.fathy.alfred.backend.dbcapture.application.port.in.StoreSummariesUseCase redis;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    void setRedis(com.fathy.alfred.backend.dbcapture.application.port.in.StoreSummariesUseCase redis) {
        this.redis = redis;
    }

    private List<Map<String, Object>> withRedis(List<com.fathy.alfred.backend.triage.domain.model.EndpointHealth> health, ResolvedScope scope) {
        Map<String, List<String>> idsByEndpoint = new LinkedHashMap<>();
        scope.calls().values().forEach(c -> idsByEndpoint
                .computeIfAbsent(com.fathy.alfred.backend.triage.domain.EndpointPattern.of(c.method(), c.path()), k -> new java.util.ArrayList<>())
                .add(c.callId()));
        com.fasterxml.jackson.databind.ObjectMapper json = new com.fasterxml.jackson.databind.ObjectMapper();
        List<Map<String, Object>> out = new java.util.ArrayList<>();
        for (com.fathy.alfred.backend.triage.domain.model.EndpointHealth e : health) {
            @SuppressWarnings("unchecked")
            Map<String, Object> row = json.convertValue(e, LinkedHashMap.class);
            List<String> ids = idsByEndpoint.getOrDefault(e.endpoint(), List.of());
            var a = redis.aggregate(ids);
            if (a.callsWithRedis() > 0) {
                Map<String, Object> r = new LinkedHashMap<>();
                r.put("callsWithRedis", a.callsWithRedis());
                r.put("redisPerCall", Math.round(10.0 * a.commands() / a.callsWithRedis()) / 10.0);
                r.put("hitRate", a.hits() + a.misses() == 0 ? null : Math.round(100.0 * a.hits() / (a.hits() + a.misses())));
                r.put("missToDbPerCall", Math.round(10.0 * a.missToDb() / a.callsWithRedis()) / 10.0);
                r.put("failedCalls", a.failedCalls());
                r.put("redisMs", Math.round(a.micros() / 1000.0));
                row.put("redis", r);
            }
            out.add(row);
        }
        return out;
    }

    public Map<String, Object> timeline(TimelineRequest r) {
        ResolvedScope scope = scopes.resolve(r.scope(), r.project(), r.from(), r.to());
        SignalTimeline timeline = analysis.timeline(scope.ids(), null, null, null, r.bucketMinutes() == null ? 1 : r.bucketMinutes());
        Map<String, Object> out = answer(scope);
        out.put("bucketMinutes", timeline.bucketMinutes());
        out.put("buckets", timeline.buckets().stream().map(b -> {
            Map<String, Object> bucket = new LinkedHashMap<>();
            bucket.put("start", Instant.ofEpochMilli(b.startMs()).toString());
            bucket.put("calls", b.calls());
            bucket.put("counts", b.counts());
            return bucket;
        }).toList());
        Map<String, String> first = new LinkedHashMap<>();
        timeline.firstSeen().forEach((s, ms) -> first.put(s.name(), Instant.ofEpochMilli(ms).toString()));
        out.put("firstSeen", first);
        return out;
    }

    // ------------------------------------------------------------------ caught lines

    public Map<String, Object> search(LogSearchRequest r) {
        if ((r.text() == null || r.text().isBlank()) && (r.pattern() == null || r.pattern().isBlank()) && r.minLevel() == null
                && r.logger() == null && r.exceptionType() == null) {
            throw new IllegalArgumentException("say what to look for: text, pattern, minLevel, logger or exceptionType");
        }
        ResolvedScope scope = scopes.resolve(r.scope(), r.project(), r.from(), r.to());
        LogSearchPage page = logs.search(scope.ids(), new LogSearchQuery(r.text(), r.pattern(), r.minLevel(), r.logger(), r.exceptionType(),
                ScopeResolver.millis(r.from(), "from"), ScopeResolver.millis(r.to(), "to"), Boolean.TRUE.equals(r.outside()), r.before(),
                r.limit() == null ? 50 : r.limit(), r.project()));
        Map<String, Object> out = answer(scope);
        out.put("total", page.total());
        out.put("hits", page.lines().stream().map(l -> hit(l, l.callId() == null ? null : scope.calls().get(l.callId()))).toList());
        out.put("next", page.nextBeforeId());
        if (page.cutShort() != null) {
            out.put("cutShort", page.cutShort());
        }
        return out;
    }

    private static Map<String, Object> hit(CaughtLogLine l, ScopeCall call) {
        Map<String, Object> hit = new LinkedHashMap<>();
        hit.put("callId", l.callId());
        if (call != null) {
            hit.put("method", call.method());
            hit.put("path", call.path());
            hit.put("status", call.status());
            hit.put("callAt", call.startedAt());
            hit.put("heldIn", call.heldIn());
        }
        hit.put("line", line(l, call == null ? null : ScopeResolver.startMillis(call.startedAt())));
        return hit;
    }

    /** A line as /call-logs serves it (lineId "c:<id>", offset from the call's start). */
    static Map<String, Object> line(CaughtLogLine l, Long callStartMs) {
        Map<String, Object> line = new LinkedHashMap<>();
        line.put("lineId", "c:" + l.id());
        line.put("seq", l.seq());
        if (callStartMs != null && callStartMs > 0) {
            line.put("offsetMs", ScopeResolver.startMillis(l.at()) - callStartMs);
        }
        line.put("at", l.at());
        line.put("level", l.level());
        line.put("logger", l.logger());
        line.put("thread", l.thread());
        line.put("message", l.message());
        if (l.exceptionType() != null || l.exceptionStack() != null) {
            Map<String, Object> e = new LinkedHashMap<>();
            e.put("type", l.exceptionType());
            e.put("message", l.exceptionMessage());
            e.put("stack", l.exceptionStack());
            line.put("exception", e);
        }
        line.put("cut", l.cut());
        if (l.callId() == null) {
            line.put("project", l.project());
        }
        return line;
    }

    public Map<String, Object> problems(LogProblemsRequest r) {
        ResolvedScope scope = scopes.resolve(r.scope(), r.project(), r.from(), r.to());
        boolean warnings = r.levels() != null && r.levels().contains("WARN");
        CallLogLinesUseCase.LogProblemsPage page = logs.problems(scope.ids(), warnings, ScopeResolver.millis(r.from(), "from"),
                ScopeResolver.millis(r.to(), "to"), r.limit() == null ? 30 : r.limit());
        long newSince = newSince(r.newSince(), scope);
        Map<String, Object> out = answer(scope);
        out.put("groups", page.groups());
        out.put("newSince", Instant.ofEpochMilli(newSince).toString());
        out.put("problems", page.problems().stream().map(p -> problem(p, scope, newSince)).toList());
        return out;
    }

    /** "New" = first seen in the later half of the scope's time, unless the caller says from when. */
    private static long newSince(String given, ResolvedScope scope) {
        Long asked = ScopeResolver.millis(given, "newSince");
        if (asked != null) {
            return asked;
        }
        long min = Long.MAX_VALUE;
        long max = Long.MIN_VALUE;
        for (ScopeCall c : scope.calls().values()) {
            long at = ScopeResolver.startMillis(c.startedAt());
            min = Math.min(min, at);
            max = Math.max(max, at);
        }
        return min == Long.MAX_VALUE ? 0 : min + (max - min) / 2;
    }

    private static Map<String, Object> problem(LogProblem p, ResolvedScope scope, long newSince) {
        Map<String, Object> out = new LinkedHashMap<>();
        CaughtLogLine sample = p.sample();
        out.put("fingerprint", p.fingerprint());
        out.put("level", sample == null ? null : sample.level());
        out.put("logger", sample == null ? null : sample.logger());
        out.put("exceptionType", sample == null ? null : sample.exceptionType());
        out.put("message", sample == null ? null : sample.message());
        out.put("lines", p.lines());
        out.put("calls", p.calls());
        out.put("firstAt", Instant.ofEpochMilli(p.firstAtMs()).toString());
        out.put("lastAt", Instant.ofEpochMilli(p.lastAtMs()).toString());
        out.put("isNew", p.firstAtMs() >= newSince);
        Map<String, Long> endpoints = p.callIds().stream().map(scope.calls()::get).filter(java.util.Objects::nonNull)
                .collect(Collectors.groupingBy(c -> EndpointPattern.of(c.method(), c.path()), LinkedHashMap::new, Collectors.counting()));
        out.put("endpoints", endpoints.entrySet().stream().sorted(Map.Entry.<String, Long>comparingByValue().reversed()).limit(5)
                .map(e -> Map.of("endpoint", e.getKey(), "calls", e.getValue())).toList());
        if (endpoints.size() > 5) {
            out.put("moreEndpoints", endpoints.size() - 5);
        }
        if (sample != null) {
            out.put("example", Map.of("callId", sample.callId() == null ? "" : sample.callId(), "lineId", "c:" + sample.id()));
        }
        return out;
    }

    public Map<String, Object> problemCallsOf(LogProblemCallsRequest r) {
        ResolvedScope scope = scopes.resolve(r.scope(), r.project(), r.from(), r.to());
        int offset = r.offset() == null ? 0 : r.offset();
        int limit = r.limit() == null ? 50 : r.limit();
        List<LogProblemCall> calls = logs.problemCalls(scope.ids(), r.fingerprint(), offset, limit + 1);
        Function<LogProblemCall, Map<String, Object>> row = c -> {
            ScopeCall call = scope.calls().get(c.callId());
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("callId", c.callId());
            if (call != null) {
                out.put("method", call.method());
                out.put("path", call.path());
                out.put("status", call.status());
                out.put("startedAt", call.startedAt());
                out.put("heldIn", call.heldIn());
            }
            out.put("lines", c.lines());
            out.put("firstAt", Instant.ofEpochMilli(c.firstAtMs()).toString());
            return out;
        };
        Map<String, Object> out = answer(scope);
        out.put("calls", new ArrayList<>(calls.subList(0, Math.min(limit, calls.size()))).stream().map(row).toList());
        out.put("next", calls.size() > limit ? offset + limit : null);
        return out;
    }
}
