package com.fathy.alfred.backend.triage.domain;

import java.net.URI;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * An endpoint as one name for calls that only differ by the ids in their path (specs/010-mcp-log-investigation,
 * research R6): {@code POST /booking/123/confirm} and {@code POST /booking/456/confirm} are {@code POST
 * /booking/{id}/confirm}. Only segments that clearly are values are replaced - numbers, UUIDs, long hex, and long
 * tokens mixing letters and digits - so an unknown shape stays separate rather than merged. The query string is
 * dropped. Pure.
 */
public final class EndpointPattern {

    private static final Pattern NUMBER = Pattern.compile("-?\\d+(\\.\\d+)?");
    private static final Pattern UUID = Pattern.compile("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}");
    private static final Pattern HEX = Pattern.compile("(?=.*\\d)[0-9a-fA-F]{8,}");
    /** A token like ORD20391 or a1b2c3d4e - three digits at least, so a name like Booking2 or Admin2 stays a name. */
    private static final Pattern MIXED = Pattern.compile("(?=(?:.*\\d){3})(?=.*[A-Za-z])[A-Za-z0-9_-]{7,}");

    private EndpointPattern() {
    }

    /** "POST /booking/{id}" - the method upper-cased, the path of the URL with id segments replaced. */
    public static String of(String method, String url) {
        return (method == null ? "?" : method.toUpperCase(Locale.ROOT)) + " " + path(url);
    }

    public static String path(String url) {
        if (url == null || url.isBlank()) {
            return "/";
        }
        String path;
        try {
            URI uri = URI.create(url.strip());
            path = uri.getRawPath() != null && uri.getHost() != null ? uri.getRawPath() : stripQuery(url.strip());
        } catch (IllegalArgumentException e) {
            path = stripQuery(url.strip());
        }
        if (path.isEmpty()) {
            return "/";
        }
        String result = java.util.Arrays.stream(path.split("/", -1)).map(seg -> isValue(seg) ? "{id}" : seg)
                .collect(java.util.stream.Collectors.joining("/"));
        return result.startsWith("/") ? result : "/" + result;
    }

    private static String stripQuery(String url) {
        int q = url.indexOf('?');
        return q >= 0 ? url.substring(0, q) : url;
    }

    private static boolean isValue(String segment) {
        if (segment.isEmpty()) {
            return false;
        }
        return NUMBER.matcher(segment).matches() || UUID.matcher(segment).matches() || HEX.matcher(segment).matches()
                || MIXED.matcher(segment).matches();
    }
}
