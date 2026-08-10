package com.fathy.alfred.backend.calls.application.service;

import com.fathy.alfred.backend.calls.domain.model.CallRecord;

import java.net.URI;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.function.Function;

/**
 * Search/filter/sort/paginate logic for any list of items that each wrap a CallRecord - shared by
 * CallsService (GET /calls, items are CallRecord itself) and SessionCyclesService
 * (GET /session-cycles/{id}/calls, items are CapturedCall) via the {@code toCall} extractor, so a
 * call ranks/searches/sorts identically regardless of which endpoint serves it. Mirrors the
 * frontend's shared/utils/call-utils.ts search/sort semantics exactly.
 */
public final class CallListSupport {

    private CallListSupport() {
    }

    /** One page of {@code T} plus the total count matching the query, before pagination. */
    public record Page<T>(List<T> items, int total) {
    }

    /**
     * @param source Calls in oldest-first (natural/insertion) order - "oldest"/"newest" are
     *               relative to this order, not to any field on CallRecord.
     * @param paginationEnabled When false, {@code offset} is ignored and every filtered/sorted
     *                          item up to {@code limit} is returned in one page (still filtered
     *                          and sorted) - reproduces the pre-pagination "just give me
     *                          everything up to the cap" behavior, driven by
     *                          {@code alfred.calls.pagination-enabled}.
     */
    public static <T> Page<T> apply(
            List<T> source,
            Function<T, CallRecord> toCall,
            String search,
            String supplier,
            String sort,
            int offset,
            int limit,
            boolean paginationEnabled
    ) {
        String query = search == null ? "" : search.trim().toLowerCase(Locale.ROOT);
        String supplierFilter = supplier == null ? "" : supplier.trim();

        List<T> filtered = source.stream()
                .filter(item -> matchesSearch(toCall.apply(item), query))
                .filter(item -> supplierFilter.isEmpty() || supplierFilter.equals(supplierOf(toCall.apply(item))))
                .toList();

        List<T> ordered = sorted(filtered, sort, toCall);

        int total = ordered.size();
        int from = paginationEnabled ? Math.max(0, Math.min(offset, total)) : 0;
        int to = Math.max(from, Math.min(from + Math.max(limit, 0), total));
        return new Page<>(ordered.subList(from, to), total);
    }

    private static <T> List<T> sorted(List<T> filtered, String sort, Function<T, CallRecord> toCall) {
        String mode = sort == null ? "newest" : sort;
        return switch (mode) {
            case "oldest" -> filtered;
            case "oldest-call" -> filtered.stream()
                    .sorted(Comparator.comparingLong(t -> callTimeMillis(toCall.apply(t))))
                    .toList();
            case "newest-call" -> filtered.stream()
                    .sorted(Comparator.<T>comparingLong(t -> callTimeMillis(toCall.apply(t))).reversed())
                    .toList();
            case "slowest" -> filtered.stream()
                    .sorted(Comparator.<T>comparingDouble(t -> durationOrDefault(toCall.apply(t), -1)).reversed())
                    .toList();
            case "fastest" -> filtered.stream()
                    .sorted(Comparator.comparingDouble(t -> durationOrDefault(toCall.apply(t), Double.POSITIVE_INFINITY)))
                    .toList();
            case "status" -> filtered.stream()
                    .sorted(Comparator.<T>comparingInt(t -> statusRank(toCall.apply(t))).reversed())
                    .toList();
            default -> reversed(filtered); // "newest" and anything unrecognized (e.g. frontend-only "custom")
        };
    }

    private static <T> List<T> reversed(List<T> list) {
        List<T> copy = new java.util.ArrayList<>(list);
        java.util.Collections.reverse(copy);
        return copy;
    }

    private static double durationOrDefault(CallRecord call, double fallback) {
        Double v = call.durationMs();
        return v == null ? fallback : v;
    }

    private static int statusRank(CallRecord call) {
        if (call.error() != null && !call.error().isBlank()) {
            return 999;
        }
        Integer status = call.response() != null ? call.response().status() : null;
        return status == null ? -1 : status;
    }

    /** Mirrors call-utils.ts's callTime(): an unparseable/missing timestamp sorts as epoch 0 rather than throwing. Accepts both Java's Instant.toString() format (trailing "Z") and the proxy's Python isoformat() output (trailing "+00:00" offset). */
    private static long callTimeMillis(CallRecord call) {
        String ts = call.timestamp();
        if (ts == null || ts.isBlank()) {
            return 0L;
        }
        try {
            return Instant.parse(ts).toEpochMilli();
        } catch (DateTimeParseException e) {
            try {
                return OffsetDateTime.parse(ts).toInstant().toEpochMilli();
            } catch (DateTimeParseException e2) {
                return 0L;
            }
        }
    }

    /** Mirrors call-utils.ts's searchHaystack()/matchesSearch(): method, both URLs, status, error, and both headers+body, concatenated and lowercased. */
    private static boolean matchesSearch(CallRecord call, String query) {
        if (query.isEmpty()) {
            return true;
        }
        StringBuilder haystack = new StringBuilder();
        append(haystack, call.method());
        append(haystack, call.originalUrl());
        append(haystack, call.url());
        if (call.response() != null) {
            haystack.append(call.response().status()).append(' ');
            if (call.response().headers() != null) {
                haystack.append(call.response().headers()).append(' ');
            }
            append(haystack, call.response().body());
        }
        append(haystack, call.error());
        if (call.request() != null) {
            if (call.request().headers() != null) {
                haystack.append(call.request().headers()).append(' ');
            }
            append(haystack, call.request().body());
        }
        return haystack.toString().toLowerCase(Locale.ROOT).contains(query);
    }

    private static void append(StringBuilder sb, String value) {
        sb.append(value == null ? "" : value).append(' ');
    }

    /** Mirrors call-utils.ts's supplierOf(): the call's URL hostname, falling back to the raw URL/original URL. */
    public static String supplierOf(CallRecord call) {
        String host = hostOf(call.url());
        if (host != null) {
            return host;
        }
        if (call.url() != null && !call.url().isBlank()) {
            return call.url();
        }
        if (call.originalUrl() != null && !call.originalUrl().isBlank()) {
            return call.originalUrl();
        }
        return "unknown";
    }

    private static String hostOf(String url) {
        if (url == null || url.isBlank()) {
            return null;
        }
        try {
            String host = URI.create(url).getHost();
            return (host == null || host.isBlank()) ? null : host;
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
