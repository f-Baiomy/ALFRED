package com.fathy.alfred.backend.board.domain.model;

import java.util.Locale;
import java.util.regex.Pattern;

/**
 * What "fixed" means for a card, in a form Alfred checks on every call to its endpoint (specs/016 FR-2):
 * <ul>
 *   <li>SQL_COUNT - at most {@code max} statements on {@code table} (every table when blank) per call;</li>
 *   <li>STATUS - the status is in {@code range}: {@code 2xx}, {@code 200}, or {@code !405} / {@code !5xx} for "not";</li>
 *   <li>NO_LOG - no log line at {@code level} (ERROR, or WARN which also counts ERROR) or above;</li>
 *   <li>DURATION - at most {@code max} ms, judged once {@code minCalls} calls were seen (default 3);</li>
 *   <li>SAME_RESPONSE - the value at JSON {@code path} ({@code $.a.b[0]}, {@code .length} for a count) equals the one in
 *       the card's original call.</li>
 * </ul>
 */
public record Expectation(Kind kind, String table, Long max, String range, String level, Integer minCalls, String path) {

    public enum Kind { SQL_COUNT, STATUS, NO_LOG, DURATION, SAME_RESPONSE }

    public static final int MAX_PER_CARD = 20;
    public static final int DEFAULT_DURATION_CALLS = 3;
    private static final Pattern RANGE = Pattern.compile("!?([1-5]xx|[1-5]\\d\\d)");
    private static final Pattern PATH = Pattern.compile("\\$(\\.[A-Za-z0-9_\\-]+|\\[\\d+])*(\\.length)?");

    public Expectation {
        table = blank(table);
        range = blank(range) == null ? null : range.trim().toLowerCase(Locale.ROOT);
        level = blank(level) == null ? null : level.trim().toUpperCase(Locale.ROOT);
        path = blank(path);
    }

    private static String blank(String s) {
        return s == null || s.isBlank() ? null : s.trim();
    }

    /** Why this expectation cannot be checked, or null when it is fine. */
    public String problem() {
        if (kind == null) {
            return "an expectation needs a kind: SQL_COUNT, STATUS, NO_LOG, DURATION or SAME_RESPONSE";
        }
        return switch (kind) {
            case SQL_COUNT -> max == null || max < 0 ? "SQL_COUNT needs max (0 or more)" : null;
            case STATUS -> range == null || !RANGE.matcher(range).matches() ? "STATUS needs range: 2xx, 200, !405 or !5xx" : null;
            case NO_LOG -> level == null || !(level.equals("ERROR") || level.equals("WARN")) ? "NO_LOG needs level ERROR or WARN" : null;
            case DURATION -> max == null || max <= 0 ? "DURATION needs max in ms"
                    : minCalls != null && (minCalls < 1 || minCalls > 50) ? "DURATION minCalls is 1 to 50" : null;
            case SAME_RESPONSE -> path == null || path.length() > 200 || !PATH.matcher(path).matches()
                    ? "SAME_RESPONSE needs a JSON path such as $.countries.length" : null;
        };
    }

    /** How many calls must be seen before this expectation is judged. */
    public int callsNeeded() {
        return kind == Kind.DURATION ? (minCalls == null ? DEFAULT_DURATION_CALLS : minCalls) : 1;
    }

    /** Whether {@code status} is in this STATUS expectation's range. */
    public boolean statusMatches(Integer status) {
        if (status == null || range == null) {
            return false;
        }
        boolean not = range.startsWith("!");
        String r = not ? range.substring(1) : range;
        boolean in = r.endsWith("xx") ? status / 100 == r.charAt(0) - '0' : String.valueOf(status).equals(r);
        return not != in;
    }

    /** One line for people: "≤ 3 queries on TT_COUNTRY_AIRLINE_MAP". */
    public String text() {
        return switch (kind) {
            case SQL_COUNT -> "≤ " + max + (max == 1 ? " query" : " queries") + (table == null ? " in all" : " on " + table);
            case STATUS -> range.startsWith("!") ? "Status not " + range.substring(1) : "Status " + range;
            case NO_LOG -> level.equals("WARN") ? "No WARN or ERROR log line" : "No ERROR log line";
            case DURATION -> "Under " + max + " ms (" + callsNeeded() + (callsNeeded() == 1 ? " call)" : " calls)");
            case SAME_RESPONSE -> "Response " + path + " the same as before the fix";
        };
    }
}
