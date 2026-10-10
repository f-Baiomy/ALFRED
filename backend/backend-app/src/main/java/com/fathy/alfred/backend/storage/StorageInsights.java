package com.fathy.alfred.backend.storage;

import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Settings → Storage's "Biggest" and "Space over time": where the space goes (busiest endpoints, largest calls, cost
 * per project, the same call recorded again and again) and how much each day added. Built from the stores' own
 * clean-up candidates - one SQL pass per direction, bodies measured with length() and never read - on demand, when
 * the tab opens. Covers the calls the stores still hold: a day the limit already removed shows what is left of it.
 */
@Service
public class StorageInsights {

    static final int DAYS = 30;
    private static final int TOP = 25;

    private final com.fathy.alfred.backend.calls.application.port.out.CallLogPort outbound;
    private final com.fathy.alfred.backend.internalcalls.application.port.out.CallLogPort inbound;
    private final Clock clock;

    public StorageInsights(com.fathy.alfred.backend.calls.application.port.out.CallLogPort outbound,
                           com.fathy.alfred.backend.internalcalls.application.port.out.CallLogPort inbound, Optional<Clock> clock) {
        this.outbound = outbound;
        this.inbound = inbound;
        this.clock = clock.orElse(Clock.systemUTC());
    }

    record CallRow(String direction, String id, String method, String url, Integer status, String project, long bytes, String at,
                   long requestBodyBytes, long responseBodyBytes) {
        CallRow(String direction, String id, String method, String url, Integer status, String project, long bytes, String at) {
            this(direction, id, method, url, status, project, bytes, at, bytes, bytes);
        }
    }

    /** {@code ids}: what "Delete these" removes; for a repeat, every copy but the newest. */
    record Group(String direction, String method, String path, String project, int calls, long bytes, String note, List<String> ids) {
    }

    record Day(String day, long inboundBytes, long outboundBytes, int inboundCalls, int outboundCalls) {
    }

    record Insights(List<Group> endpoints, List<CallRow> largest, List<Group> projects, List<Group> repeats, long repeatBytes,
                    int repeatCalls, List<Day> days, long perDayBytes) {
    }

    public Insights insights() {
        List<CallRow> rows = new ArrayList<>();
        try {
            for (var c : inbound.cleanupCandidates(new com.fathy.alfred.backend.internalcalls.domain.model.CleanupFilter(null, null, null, null),
                    StorageService.MAX_CLEANUP)) {
                rows.add(new CallRow("inbound", c.id(), c.method(), c.url(), c.status(), c.project(), c.bytes(), c.timestamp(),
                        c.requestBodyBytes(), c.responseBodyBytes()));
            }
        } catch (RuntimeException ignored) {
            // a file store cannot list candidates: inbound simply shows nothing here
        }
        try {
            for (var c : outbound.cleanupCandidates(new com.fathy.alfred.backend.calls.domain.model.CleanupFilter(null, null, null, null),
                    StorageService.MAX_CLEANUP)) {
                rows.add(new CallRow("outbound", c.id(), c.method(), c.url(), c.status(), c.project(), c.bytes(), c.timestamp(),
                        c.requestBodyBytes(), c.responseBodyBytes()));
            }
        } catch (RuntimeException ignored) {
            // as above
        }
        return analyse(rows, clock.instant());
    }

    static Insights analyse(List<CallRow> rows, Instant now) {
        // ---- busiest endpoints: method + path (no query), per direction
        Map<String, List<CallRow>> byEndpoint = new LinkedHashMap<>();
        for (CallRow r : rows) {
            byEndpoint.computeIfAbsent(r.direction() + " " + upper(r.method()) + " " + path(r.url()), k -> new ArrayList<>()).add(r);
        }
        List<Group> endpoints = new ArrayList<>();
        for (List<CallRow> list : byEndpoint.values()) {
            CallRow first = list.get(0);
            long bytes = list.stream().mapToLong(CallRow::bytes).sum();
            endpoints.add(new Group(first.direction(), upper(first.method()), path(first.url()), first.project(), list.size(), bytes,
                    endpointNote(list, bytes), list.stream().map(CallRow::id).toList()));
        }
        endpoints.sort(Comparator.comparingLong(Group::bytes).reversed());

        // ---- largest single calls
        List<CallRow> largest = rows.stream().sorted(Comparator.comparingLong(CallRow::bytes).reversed()).limit(TOP).toList();

        // ---- per project / supplier
        Map<String, List<CallRow>> byProject = new LinkedHashMap<>();
        for (CallRow r : rows) {
            byProject.computeIfAbsent(r.direction() + " " + (r.project() == null || r.project().isBlank() ? "(none)" : r.project()),
                    k -> new ArrayList<>()).add(r);
        }
        List<Group> projects = new ArrayList<>();
        for (List<CallRow> list : byProject.values()) {
            CallRow first = list.get(0);
            projects.add(new Group(first.direction(), null, null, first.project() == null || first.project().isBlank() ? "(none)" : first.project(),
                    list.size(), list.stream().mapToLong(CallRow::bytes).sum(), null, List.of()));
        }
        projects.sort(Comparator.comparingLong(Group::bytes).reversed());

        // ---- repeats: the same method, full URL, status and both body sizes, again and again; the newest of each is kept
        Map<String, List<CallRow>> byRepeat = new LinkedHashMap<>();
        for (CallRow r : rows) {
            byRepeat.computeIfAbsent(r.direction() + "|" + upper(r.method()) + "|" + r.url() + "|" + r.status() + "|"
                            + r.requestBodyBytes() + "|" + r.responseBodyBytes(),
                    k -> new ArrayList<>()).add(r);
        }
        List<Group> repeats = new ArrayList<>();
        long repeatBytes = 0;
        int repeatCalls = 0;
        for (List<CallRow> list : byRepeat.values()) {
            if (list.size() < 2) {
                continue;
            }
            List<CallRow> sorted = list.stream().sorted(Comparator.comparing(CallRow::at, Comparator.nullsFirst(Comparator.naturalOrder()))).toList();
            List<String> copies = sorted.subList(0, sorted.size() - 1).stream().map(CallRow::id).toList();
            CallRow first = sorted.get(0);
            long freed = first.bytes() * copies.size();
            repeatBytes += freed;
            repeatCalls += copies.size();
            repeats.add(new Group(first.direction(), upper(first.method()), first.url(), first.project(), copies.size(), freed,
                    "same URL, status, request and response size", copies));
        }
        repeats.sort(Comparator.comparingLong(Group::bytes).reversed());

        // ---- what each of the last 30 days added (of the calls still stored)
        LocalDate today = now.atZone(ZoneOffset.UTC).toLocalDate();
        Map<LocalDate, long[]> perDay = new LinkedHashMap<>();
        for (int i = DAYS - 1; i >= 0; i--) {
            perDay.put(today.minusDays(i), new long[4]);
        }
        for (CallRow r : rows) {
            Instant at = instant(r.at());
            if (at == null) {
                continue;
            }
            long[] d = perDay.get(at.atZone(ZoneOffset.UTC).toLocalDate());
            if (d == null) {
                continue;
            }
            int o = "inbound".equals(r.direction()) ? 0 : 1;
            d[o] += r.bytes();
            d[o + 2]++;
        }
        List<Day> days = perDay.entrySet().stream()
                .map(e -> new Day(e.getKey().toString(), e.getValue()[0], e.getValue()[1], (int) e.getValue()[2], (int) e.getValue()[3]))
                .toList();
        // the recent rate: the last 7 days that have any calls (a limit may have removed older ones)
        List<Day> recent = days.subList(days.size() - 7, days.size()).stream().filter(d -> d.inboundCalls() + d.outboundCalls() > 0).toList();
        long perDayBytes = recent.isEmpty() ? 0 : recent.stream().mapToLong(d -> d.inboundBytes() + d.outboundBytes()).sum() / recent.size();

        return new Insights(endpoints.subList(0, Math.min(TOP, endpoints.size())), largest, projects,
                repeats.subList(0, Math.min(TOP, repeats.size())), repeatBytes, repeatCalls, days, perDayBytes);
    }

    private static String endpointNote(List<CallRow> list, long bytes) {
        if ("OPTIONS".equals(upper(list.get(0).method()))) {
            return "CORS preflight - hidden in the call lists";
        }
        String p = path(list.get(0).url()).toLowerCase(java.util.Locale.ROOT);
        if (p.contains("health") || p.contains("actuator") || p.endsWith("/ping")) {
            return "health check";
        }
        long avg = bytes / Math.max(1, list.size());
        if (avg >= 1024L * 1024) {
            return String.format(java.util.Locale.ROOT, "%.1f MB in each call", avg / 1048576.0);
        }
        if (list.size() >= 100) {
            List<Instant> times = list.stream().map(r -> instant(r.at())).filter(t -> t != null).sorted().toList();
            if (times.size() >= 2) {
                long seconds = Duration.between(times.get(0), times.get(times.size() - 1)).toSeconds() / (times.size() - 1);
                if (seconds <= 60) {
                    return "called about every " + Math.max(1, seconds) + " s";
                }
            }
        }
        return null;
    }

    static String path(String url) {
        if (url == null) {
            return "";
        }
        int q = url.indexOf('?');
        return q < 0 ? url : url.substring(0, q);
    }

    private static String upper(String method) {
        return method == null ? "" : method.toUpperCase(java.util.Locale.ROOT);
    }

    private static Instant instant(String iso) {
        if (iso == null) {
            return null;
        }
        try {
            return java.time.OffsetDateTime.parse(iso).toInstant();
        } catch (RuntimeException e) {
            try {
                return Instant.parse(iso);
            } catch (RuntimeException e2) {
                return null;
            }
        }
    }
}
