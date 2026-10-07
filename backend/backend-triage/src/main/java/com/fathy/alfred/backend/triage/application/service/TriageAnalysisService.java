package com.fathy.alfred.backend.triage.application.service;

import com.fathy.alfred.backend.triage.application.port.in.AnalyseCallsUseCase;
import com.fathy.alfred.backend.triage.application.port.out.AttentionStorePort;
import com.fathy.alfred.backend.triage.domain.EndpointPattern;
import com.fathy.alfred.backend.triage.domain.model.CallAttention;
import com.fathy.alfred.backend.triage.domain.model.EndpointHealth;
import com.fathy.alfred.backend.triage.domain.model.ProblemCall;
import com.fathy.alfred.backend.triage.domain.model.ProblemCallsPage;
import com.fathy.alfred.backend.triage.domain.model.ProblemFilter;
import com.fathy.alfred.backend.triage.domain.model.Signal;
import com.fathy.alfred.backend.triage.domain.model.SignalTimeline;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.TreeMap;

/**
 * Problem calls, endpoint health and the signal timeline (specs/010-mcp-log-investigation) over the saved marks of a set
 * of calls - read once per request (columns only, by primary key), filtered and counted here.
 */
@Service
public class TriageAnalysisService implements AnalyseCallsUseCase {

    private final AttentionStorePort store;

    public TriageAnalysisService(AttentionStorePort store) {
        this.store = store;
    }

    private List<CallAttention> marks(Collection<String> callIds, String project, Long fromMs, Long toMs) {
        List<String> ids = callIds.stream().filter(Objects::nonNull).distinct().toList();
        return store.findAll(ids).stream()
                .filter(c -> project == null || project.isBlank() || project.equals(c.project()))
                .filter(c -> fromMs == null || c.startedAt() >= fromMs)
                .filter(c -> toMs == null || c.startedAt() <= toMs)
                .toList();
    }

    /** A call's signals under the filter: DB_WARNING only for the asked flags, when some are asked. */
    static List<Signal> signalsOf(CallAttention call, ProblemFilter filter) {
        List<Signal> signals = new ArrayList<>(Signal.of(call, filter.minStatus()));
        if (!filter.dbFlags().isEmpty() && call.signals().dbFlags().stream().noneMatch(filter.dbFlags()::contains)) {
            signals.remove(Signal.DB_WARNING);
        }
        return signals;
    }

    @Override
    public ProblemCallsPage problemCalls(Collection<String> callIds, ProblemFilter filter, int offset, int limit) {
        List<CallAttention> rows = marks(callIds, filter.project(), filter.fromMs(), filter.toMs());
        Map<Signal, Integer> counts = new EnumMap<>(Signal.class);
        for (Signal s : Signal.values()) {
            counts.put(s, 0);
        }
        List<ProblemCall> kept = new ArrayList<>();
        for (CallAttention row : rows) {
            List<Signal> signals = signalsOf(row, filter);
            signals.forEach(s -> counts.merge(s, 1, Integer::sum));
            if (filter.keeps(signals)) {
                boolean error = signals.stream().anyMatch(Signal::error);
                kept.add(new ProblemCall(row, signals, error ? "error" : "warning"));
            }
        }
        kept.sort(Comparator.comparing((ProblemCall p) -> "error".equals(p.severity()) ? 0 : 1)
                .thenComparing(p -> -p.signals().size())
                .thenComparing(p -> -p.call().startedAt()));
        int from = Math.max(0, offset);
        int size = limit <= 0 ? 50 : Math.min(limit, MAX_PAGE);
        List<ProblemCall> page = kept.subList(Math.min(from, kept.size()), Math.min(from + size, kept.size()));
        Integer next = from + size < kept.size() ? from + size : null;
        return new ProblemCallsPage(counts, rows.size(), kept.size(), List.copyOf(page), next);
    }

    @Override
    public List<EndpointHealth> endpoints(Collection<String> callIds, String project, Long fromMs, Long toMs, int limit) {
        Map<String, List<CallAttention>> byEndpoint = new LinkedHashMap<>();
        for (CallAttention row : marks(callIds, project, fromMs, toMs)) {
            byEndpoint.computeIfAbsent(EndpointPattern.of(row.method(), row.url()), k -> new ArrayList<>()).add(row);
        }
        List<EndpointHealth> out = new ArrayList<>();
        ProblemFilter plain = ProblemFilter.everything();
        byEndpoint.forEach((endpoint, rows) -> {
            int errorCalls = 0;
            int warningCalls = 0;
            int[] n = new int[Signal.values().length];
            List<Double> durations = new ArrayList<>();
            for (CallAttention row : rows) {
                List<Signal> signals = signalsOf(row, plain);
                signals.forEach(s -> n[s.ordinal()]++);
                if (signals.stream().anyMatch(Signal::error)) {
                    errorCalls++;
                } else if (!signals.isEmpty()) {
                    warningCalls++;
                }
                if (row.durationMs() != null) {
                    durations.add(row.durationMs());
                }
            }
            durations.sort(Double::compare);
            Double median = durations.isEmpty() ? null : durations.get(durations.size() / 2);
            Double max = durations.isEmpty() ? null : durations.get(durations.size() - 1);
            out.add(new EndpointHealth(endpoint, rows.size(), errorCalls, warningCalls,
                    n[Signal.HTTP_ERROR.ordinal()] + n[Signal.NO_ANSWER.ordinal()], n[Signal.DB_FAILED.ordinal()], n[Signal.DB_WARNING.ordinal()],
                    n[Signal.LOG_ERROR.ordinal()], n[Signal.LOG_WARNING.ordinal()], n[Signal.SUPPLIER_FAILED.ordinal()], median, max,
                    n[Signal.REDIS_FAILED.ordinal()], n[Signal.CACHE_COLD.ordinal()]));
        });
        out.sort(Comparator.comparing((EndpointHealth e) -> -e.errorCalls()).thenComparing(e -> -e.warningCalls())
                .thenComparing(e -> -e.calls()));
        return List.copyOf(out.subList(0, Math.min(out.size(), limit <= 0 ? 50 : Math.min(limit, MAX_PAGE))));
    }

    @Override
    public SignalTimeline timeline(Collection<String> callIds, String project, Long fromMs, Long toMs, int bucketMinutes) {
        List<CallAttention> rows = marks(callIds, project, fromMs, toMs);
        if (rows.isEmpty()) {
            return new SignalTimeline(Math.max(1, bucketMinutes), List.of(), Map.of());
        }
        long first = rows.stream().mapToLong(CallAttention::startedAt).min().orElse(0);
        long last = rows.stream().mapToLong(CallAttention::startedAt).max().orElse(0);
        long spanMinutes = (last - first) / 60_000 + 1;
        int minutes = (int) Math.max(Math.max(1, bucketMinutes), (spanMinutes + MAX_BUCKETS - 1) / MAX_BUCKETS);
        long width = minutes * 60_000L;
        TreeMap<Long, int[]> buckets = new TreeMap<>();
        TreeMap<Long, Integer> callsPerBucket = new TreeMap<>();
        Map<Signal, Long> firstSeen = new EnumMap<>(Signal.class);
        ProblemFilter plain = ProblemFilter.everything();
        for (CallAttention row : rows) {
            long start = Math.floorDiv(row.startedAt(), width) * width;
            int[] counts = buckets.computeIfAbsent(start, k -> new int[Signal.values().length]);
            callsPerBucket.merge(start, 1, Integer::sum);
            for (Signal s : signalsOf(row, plain)) {
                counts[s.ordinal()]++;
                firstSeen.merge(s, row.startedAt(), Math::min);
            }
        }
        List<SignalTimeline.Bucket> out = new ArrayList<>();
        buckets.forEach((start, counts) -> {
            Map<Signal, Integer> named = new EnumMap<>(Signal.class);
            for (Signal s : Signal.values()) {
                if (counts[s.ordinal()] > 0) {
                    named.put(s, counts[s.ordinal()]);
                }
            }
            out.add(new SignalTimeline.Bucket(start, callsPerBucket.get(start), named));
        });
        return new SignalTimeline(minutes, out, firstSeen);
    }
}
