package com.fathy.alfred.backend.triage.application.service;

import com.fathy.alfred.backend.triage.application.port.in.QueryAttentionUseCase;
import com.fathy.alfred.backend.triage.application.port.in.RecordCallAttentionUseCase;
import com.fathy.alfred.backend.triage.application.port.out.AttentionNotificationPort;
import com.fathy.alfred.backend.triage.application.port.out.AttentionStorePort;
import com.fathy.alfred.backend.triage.application.port.out.RetainedCallIdsPort;
import com.fathy.alfred.backend.triage.domain.Priority;
import com.fathy.alfred.backend.triage.domain.SoftFailures;
import com.fathy.alfred.backend.triage.domain.model.CallAttention;
import com.fathy.alfred.backend.triage.domain.model.CallSignals;
import com.fathy.alfred.backend.triage.domain.model.CallDirection;
import com.fathy.alfred.backend.triage.domain.model.ObservedCall;
import com.fathy.alfred.backend.triage.domain.model.SoftFailure;
import com.fathy.alfred.backend.triage.domain.model.TriageEntry;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

/**
 * Keeps call_attention current and answers triage from it.
 *
 * <p>Writes run on one writer thread, in the order they were reported: a webhook hands the call over and returns, the
 * body is read for an error inside a 2xx and an empty result there, and no two writes ever race for a row. Arrival
 * order does not matter - whatever comes first (the call, one of its supplier calls, its failed statements) creates the
 * row and each later fact updates it and re-ranks it, and its parent when it has one.
 */
@Service
public class TriageService implements RecordCallAttentionUseCase, QueryAttentionUseCase {

    private static final Logger log = LoggerFactory.getLogger(TriageService.class);
    static final String BACKFILL_MARKER = "backfill-v2";
    static final String SIGNALS_BACKFILL_MARKER = "signals-backfill-done";
    /** Rows written between two checks of the row cap. */
    static final int PRUNE_EVERY = 200;

    private final AttentionStorePort store;
    private final AttentionNotificationPort notifications;
    private final RetainedCallIdsPort retained;
    private final Executor writer;
    private final Clock clock;
    private final int retentionRows;
    private int writesSincePrune;

    @Autowired
    public TriageService(AttentionStorePort store, AttentionNotificationPort notifications, RetainedCallIdsPort retained,
                         @Value("${alfred.triage.retention-rows:100000}") int retentionRows) {
        this(store, notifications, retained, newWriter(), Clock.systemUTC(), retentionRows);
    }

    TriageService(AttentionStorePort store, AttentionNotificationPort notifications, RetainedCallIdsPort retained, Executor writer,
                  Clock clock, int retentionRows) {
        this.store = store;
        this.notifications = notifications;
        this.retained = retained;
        this.writer = writer;
        this.clock = clock;
        this.retentionRows = Math.max(100, retentionRows);
    }

    /**
     * One thread, so marks are written in order. The queue is bounded: past 10,000 waiting calls the reporting thread
     * writes its own call instead of growing memory without limit (bodies wait in this queue).
     */
    private static ExecutorService newWriter() {
        return new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(10_000), runnable -> {
            Thread thread = new Thread(runnable, "triage-writer");
            thread.setDaemon(true);
            return thread;
        }, new ThreadPoolExecutor.CallerRunsPolicy());
    }

    @PreDestroy
    void stop() {
        if (writer instanceof ExecutorService service) {
            service.shutdown();
        }
    }

    // ------------------------------------------------------------------ writes

    @Override
    public void callObserved(ObservedCall call) {
        if (call == null || call.callId() == null || call.callId().isBlank()) {
            return;
        }
        writer.execute(() -> guarded(() -> record(call)));
    }

    @Override
    public void statementFailures(String callId, int failedCount, int swallowedCount) {
        if (callId == null || callId.isBlank()) {
            return;
        }
        writer.execute(() -> guarded(() -> recordFailures(callId, failedCount, swallowedCount)));
    }

    @Override
    public void signals(String callId, CallSignals signals) {
        if (callId == null || callId.isBlank() || signals == null) {
            return;
        }
        writer.execute(() -> guarded(() -> {
            CallAttention row = store.find(callId).orElseGet(() -> placeholder(callId));
            written(Set.of(rerank(row.withSignals(signals))));
        }));
    }

    @Override
    public boolean signalsBackfillNeeded() {
        return !store.hasMarker(SIGNALS_BACKFILL_MARKER);
    }

    @Override
    public void signalsBackfillDone(int calls) {
        writer.execute(() -> guarded(() -> {
            store.setMarker(SIGNALS_BACKFILL_MARKER, clock.instant().toString());
            log.info("triage: took the log and database signals of {} calls captured before this version", calls);
        }));
    }

    @Override
    public boolean backfillNeeded() {
        return !store.hasMarker(BACKFILL_MARKER);
    }

    @Override
    public void backfillDone(int calls) {
        writer.execute(() -> guarded(() -> {
            store.setMarker(BACKFILL_MARKER, clock.instant().toString());
            log.info("triage: marked {} calls recorded before this version", calls);
        }));
    }

    /** A failed write is logged and dropped - triage is a reading aid; it must never take the call pipeline down. */
    private void guarded(Runnable work) {
        try {
            work.run();
        } catch (RuntimeException e) {
            log.error("triage: could not record a call's mark", e);
        }
    }

    private void record(ObservedCall call) {
        Optional<CallAttention> existing = store.find(call.callId());
        boolean prepared = CallAttention.IN_PROGRESS.equals(call.state());
        if (prepared && existing.isPresent() && !CallAttention.UNKNOWN.equals(existing.get().state())
                && !CallAttention.IN_PROGRESS.equals(existing.get().state())) {
            return; // a late "prepared" never undoes a completion
        }
        SoftFailure soft = prepared ? null : SoftFailures.softFailureOf(call.status(), call.error(), call.responseBody());
        List<String> empty = prepared ? null : SoftFailures.emptyResultOf(call.status(), call.error(), call.responseBody());
        CallAttention before = existing.orElse(null);
        String parent = call.parentCallId() != null ? call.parentCallId() : before == null ? null : before.parentCallId();
        CallAttention row = new CallAttention(call.callId(), call.direction(),
                call.project() != null ? call.project() : before == null ? null : before.project(), parent,
                call.method(), call.url(), call.status(), call.error(), epochMillis(call.startedAt()), call.durationMs(),
                call.state() == null ? "COMPLETED" : call.state(), soft, empty,
                0, before == null ? 0 : before.failedStatements(), before == null ? 0 : before.swallowedStatements(), 6,
                before == null ? CallSignals.NONE : before.signals());
        Set<String> changed = new LinkedHashSet<>();
        changed.add(rerank(row));
        if (parent != null) {
            changed.add(rerank(store.find(parent).orElseGet(() -> placeholder(parent))));
        }
        written(changed);
    }

    private void recordFailures(String callId, int failed, int swallowed) {
        CallAttention row = store.find(callId).orElseGet(() -> placeholder(callId));
        written(Set.of(rerank(row.withCounts(row.failingChildren(), failed, swallowed, row.priority()))));
    }

    /** Recounts the call's failing supplier calls, ranks it at the stored threshold and saves it. */
    private String rerank(CallAttention row) {
        long now = clock.millis();
        int failing = Priority.countFailing(store.children(List.of(row.callId())), Priority.STORED_MIN_STATUS, now);
        CallAttention counted = row.withCounts(failing, row.failedStatements(), row.swallowedStatements(), 0);
        store.save(counted.withCounts(failing, row.failedStatements(), row.swallowedStatements(),
                Priority.of(counted, failing, Priority.STORED_MIN_STATUS, now)));
        return row.callId();
    }

    /** A row for a call whose supplier calls or statements arrived before the call itself was reported. */
    private CallAttention placeholder(String callId) {
        return new CallAttention(callId, CallDirection.INBOUND, null, null, null, null, null, null, clock.millis(), null,
                CallAttention.UNKNOWN, null, List.of(), 0, 0, 0, 6);
    }

    private void written(Set<String> changed) {
        notifications.attentionChanged(changed);
        if (++writesSincePrune >= PRUNE_EVERY) {
            writesSincePrune = 0;
            prune();
        }
    }

    /** Past the cap plus 10 %, back down to the cap - oldest first, never a call a session cycle holds. */
    private void prune() {
        long size = store.size();
        if (size <= retentionRows + retentionRows / 10) {
            return;
        }
        int removed = store.deleteOldest((int) (size - retentionRows), retained.retainedCallIds());
        log.info("triage: removed {} oldest call marks (cap {})", removed, retentionRows);
    }

    /** The proxies write "+00:00" offsets (Python isoformat), Java writes "Z"; a naive timestamp is read as UTC. */
    static Long parseInstant(String instant) {
        if (instant == null || instant.isBlank()) {
            return null;
        }
        try {
            return java.time.OffsetDateTime.parse(instant).toInstant().toEpochMilli();
        } catch (DateTimeParseException e) {
            try {
                return java.time.LocalDateTime.parse(instant).toInstant(java.time.ZoneOffset.UTC).toEpochMilli();
            } catch (DateTimeParseException ignored) {
                return null;
            }
        }
    }

    private long epochMillis(String instant) {
        Long parsed = parseInstant(instant);
        return parsed == null ? clock.millis() : parsed;
    }

    // ------------------------------------------------------------------ reads

    @Override
    public Map<String, TriageEntry> forCalls(List<String> callIds, Integer minStatus) {
        List<String> ids = callIds.stream().filter(id -> id != null && !id.isBlank()).distinct().toList();
        if (ids.size() > MAX_IDS) {
            throw new IllegalArgumentException("At most " + MAX_IDS + " call ids per request, got " + ids.size());
        }
        if (ids.isEmpty()) {
            return Map.of();
        }
        Map<String, TriageEntry> result = new LinkedHashMap<>();
        entries(store.findAll(ids), Priority.clampMinStatus(minStatus)).forEach(entry -> result.put(entry.call().callId(), entry));
        return result;
    }

    @Override
    public List<TriageEntry> live(String project, Instant since, Instant to, int maxPriority, Integer minStatus, int limit) {
        int max = Math.max(1, Math.min(6, maxPriority));
        int clamped = Math.max(1, Math.min(MAX_LIMIT, limit));
        long now = clock.millis();
        long from = since == null ? now - 3_600_000L : since.toEpochMilli();
        long until = to == null ? Long.MAX_VALUE : to.toEpochMilli();
        List<CallAttention> rows = store.live(blankToNull(project), from, until, max, now - Priority.STALE_IN_PROGRESS_MS, clamped);
        return entries(rows, Priority.clampMinStatus(minStatus)).stream().filter(e -> e.priority() <= max).toList();
    }

    @Override
    public Map<Integer, Integer> counts(String project, Instant since, Instant to) {
        long now = clock.millis();
        Map<Integer, Integer> counts = new LinkedHashMap<>();
        for (int p = 1; p <= 6; p++) {
            counts.put(p, 0);
        }
        store.counts(blankToNull(project), since == null ? now - 3_600_000L : since.toEpochMilli(), to == null ? Long.MAX_VALUE : to.toEpochMilli())
                .forEach(counts::put);
        return counts;
    }

    private List<TriageEntry> entries(List<CallAttention> rows, int minStatus) {
        if (rows.isEmpty()) {
            return List.of();
        }
        long now = clock.millis();
        Map<String, List<CallAttention>> childrenByParent = store.children(rows.stream().map(CallAttention::callId).toList()).stream()
                .collect(Collectors.groupingBy(CallAttention::parentCallId));
        List<TriageEntry> entries = new ArrayList<>(rows.size());
        for (CallAttention row : rows) {
            List<CallAttention> failing = childrenByParent.getOrDefault(row.callId(), List.of()).stream()
                    .filter(c -> Priority.failingSupplierCall(c, minStatus, now))
                    .sorted(Comparator.comparingLong(CallAttention::startedAt))
                    .toList();
            entries.add(new TriageEntry(row, Priority.of(row, failing.size(), minStatus, now), Priority.needsAttention(row, minStatus, now), failing));
        }
        return entries;
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value;
    }
}
