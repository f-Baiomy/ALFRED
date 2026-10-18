package com.fathy.alfred.backend.sessioncycles.application.service;

import com.fathy.alfred.backend.sessioncycles.application.port.in.CycleNotesUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.out.CapturedCallsStorePort;
import com.fathy.alfred.backend.sessioncycles.application.port.out.CapturedInternalCallsStorePort;
import com.fathy.alfred.backend.sessioncycles.application.port.out.SessionCycleMetadataStorePort;
import com.fathy.alfred.backend.sessioncycles.application.port.out.SessionCycleNotificationPort;
import com.fathy.alfred.backend.sessioncycles.domain.model.CycleSummary;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * A cycle's notes and its summary (specs/033). The summary reads the captured calls' list shape only - no bodies - from
 * both stores, every call of the cycle (a cycle is a bounded manual recording), and counts them here.
 */
@Service
public class CycleNotesService implements CycleNotesUseCase {

    static final String INBOUND = "INBOUND";
    static final String OUTBOUND = "OUTBOUND";
    private static final int ALL = 1_000_000;

    private final SessionCycleMetadataStorePort metadataStore;
    private final CapturedCallsStorePort capturedCallsStore;
    private final CapturedInternalCallsStorePort capturedInternalCallsStore;
    private final SessionCycleNotificationPort notificationPort;

    public CycleNotesService(SessionCycleMetadataStorePort metadataStore, CapturedCallsStorePort capturedCallsStore,
                             CapturedInternalCallsStorePort capturedInternalCallsStore, SessionCycleNotificationPort notificationPort) {
        this.metadataStore = metadataStore;
        this.capturedCallsStore = capturedCallsStore;
        this.capturedInternalCallsStore = capturedInternalCallsStore;
        this.notificationPort = notificationPort;
    }

    @Override
    public synchronized Optional<SessionCycle> updateNotes(String cycleId, String description, String summary) {
        if (description != null && description.length() > DESCRIPTION_MAX) {
            throw new IllegalArgumentException("The description is longer than " + DESCRIPTION_MAX + " characters");
        }
        if (summary != null && summary.length() > SUMMARY_MAX) {
            throw new IllegalArgumentException("The summary is longer than " + SUMMARY_MAX + " characters");
        }
        return metadataStore.findById(cycleId).map(existing -> {
            SessionCycle saved = metadataStore.save(existing.withNotes(description, summary));
            notificationPort.notifySessionCyclesChanged();
            return saved;
        });
    }

    @Override
    public Optional<CycleSummary> summary(String cycleId) {
        if (metadataStore.findById(cycleId).isEmpty()) return Optional.empty();
        List<Row> rows = new ArrayList<>();
        for (var c : capturedInternalCallsStore.query(cycleId, null, null, "oldest-call", 0, ALL, false).items()) {
            var call = c.call();
            rows.add(new Row(INBOUND, call.id(), call.timestamp(), call.method(), call.url(), call.status(), call.durationMs(), call.error()));
        }
        for (var c : capturedCallsStore.query(cycleId, null, null, "oldest-call", 0, ALL, false).items()) {
            var call = c.call();
            rows.add(new Row(OUTBOUND, call.id(), call.timestamp(), call.method(), call.url(), call.status(), call.durationMs(), call.error()));
        }
        return Optional.of(summarize(cycleId, rows));
    }

    /** One captured call, as the summary needs it. */
    record Row(String direction, String callId, String at, String method, String url, Integer status, Double ms, String error) {
        boolean failed() {
            return (status != null && status >= 400) || (error != null && !error.isBlank());
        }
    }

    static CycleSummary summarize(String cycleId, List<Row> unordered) {
        List<Row> rows = unordered.stream().sorted(Comparator.comparingLong(r -> millis(r.at()))).toList();
        Set<String> hosts = new LinkedHashSet<>();
        Map<String, List<Row>> byEndpoint = new LinkedHashMap<>();
        List<Double> times = new ArrayList<>();
        List<String> inboundIds = new ArrayList<>();
        int failed = 0;
        for (Row r : rows) {
            String host = hostOf(r.url());
            if (host != null) hosts.add(host);
            byEndpoint.computeIfAbsent(r.direction() + " " + upper(r.method()) + " " + pathOf(r.url()), k -> new ArrayList<>()).add(r);
            if (r.ms() != null) times.add(r.ms());
            if (r.failed()) failed++;
            if (INBOUND.equals(r.direction()) && r.callId() != null && inboundIds.size() < CycleSummary.IDS_MAX) inboundIds.add(r.callId());
        }
        List<CycleSummary.Endpoint> endpoints = new ArrayList<>();
        for (List<Row> list : byEndpoint.values()) {
            Row last = list.get(list.size() - 1);
            List<Double> ms = list.stream().map(Row::ms).filter(java.util.Objects::nonNull).toList();
            endpoints.add(new CycleSummary.Endpoint(last.direction(), upper(last.method()), pathOf(last.url()), list.size(),
                    (int) list.stream().filter(Row::failed).count(), last.status(), median(ms),
                    ms.stream().max(Double::compare).orElse(null), last.at()));
        }
        List<CycleSummary.Point> strip = rows.subList(Math.max(0, rows.size() - CycleSummary.STRIP_MAX), rows.size()).stream()
                .map(r -> new CycleSummary.Point(r.direction(), r.callId(), r.at(), upper(r.method()), pathOf(r.url()), r.status(), r.ms(), r.failed()))
                .toList();
        return new CycleSummary(cycleId, rows.size(), failed, rows.isEmpty() ? null : rows.get(0).at(),
                rows.isEmpty() ? null : rows.get(rows.size() - 1).at(), median(times), List.copyOf(hosts), endpoints, strip, inboundIds);
    }

    static String pathOf(String url) {
        if (url == null || url.isBlank()) return "/";
        String s = url;
        int q = s.indexOf('?');
        if (q >= 0) s = s.substring(0, q);
        int scheme = s.indexOf("://");
        if (scheme >= 0) {
            int slash = s.indexOf('/', scheme + 3);
            s = slash < 0 ? "/" : s.substring(slash);
        }
        return s.isEmpty() ? "/" : s;
    }

    static String hostOf(String url) {
        if (url == null || !url.contains("://")) return null;
        try {
            URI u = URI.create(url.replace(" ", "%20"));
            if (u.getHost() == null) return null;
            return u.getPort() > 0 ? u.getHost() + ":" + u.getPort() : u.getHost();
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    static Double median(List<Double> values) {
        if (values.isEmpty()) return null;
        List<Double> sorted = values.stream().sorted().toList();
        int n = sorted.size();
        return n % 2 == 1 ? sorted.get(n / 2) : (sorted.get(n / 2 - 1) + sorted.get(n / 2)) / 2;
    }

    private static long millis(String at) {
        try {
            return at == null ? Long.MAX_VALUE : Instant.parse(at).toEpochMilli();
        } catch (RuntimeException e) {
            return Long.MAX_VALUE;
        }
    }

    private static String upper(String method) {
        return method == null ? "?" : method.toUpperCase();
    }
}
