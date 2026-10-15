package com.fathy.alfred.backend.board.domain.model;

import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * One thing about a call to an Acceptance item's endpoint (specs/018), checked in code on every such call:
 * <ul>
 *   <li>REQUEST_SHAPE - what the request must be ABLE to carry, whatever the user chose: the value at {@code path}, when
 *       present, is a {@code list} or a {@code scalar}; or it is always {@code present}. A call that fails it cannot
 *       meet the item - the feature is missing (one {@code branchId} where several branches must fit);</li>
 *   <li>REQUEST_WHEN - which calls exercise the item: the value at {@code path} is {@code none} (absent, null, empty or
 *       an "all" marker), {@code one} (a single value or a list of one), {@code list}, {@code list>=2} or
 *       {@code present}. A call that does not match is about another choice and says nothing about this item;</li>
 *   <li>ROWS_MATCH_FILTER - every row of the response list at {@code rows} has {@code field} among the request values at
 *       {@code path} (no filter in the request: every row matches);</li>
 *   <li>ROWS_PRESENT - the response list at {@code rows} has at least {@code min} rows (1 by default) - without rows
 *       the other checks prove nothing;</li>
 *   <li>STATUS - the status is in {@code range}, as a re-test's STATUS expectation.</li>
 * </ul>
 * A path's last key, and {@code field}, may end in {@code *} ({@code $.branch*}): it names the one key starting so -
 * the field's real name need not be known yet. Several such keys make the check UNKNOWN for that call; none is read as
 * absent.
 */
public record EvidenceCheck(Kind kind, String path, String shape, String rows, String field, Integer min, String range) {

    public enum Kind { REQUEST_SHAPE, REQUEST_WHEN, ROWS_MATCH_FILTER, ROWS_PRESENT, STATUS }

    public static final Set<String> MUST_SHAPES = Set.of("list", "scalar", "present");
    public static final Set<String> WHEN_SHAPES = Set.of("none", "one", "list", "list>=2", "present");
    private static final Pattern PATH = Pattern.compile("\\$(\\.[A-Za-z0-9_\\-]+|\\[\\d+])*(\\.[A-Za-z0-9_\\-]*\\*)?");
    private static final Pattern FIELD = Pattern.compile("[A-Za-z0-9_\\-]+\\*?|\\*");
    private static final Pattern RANGE = Pattern.compile("!?([1-5]xx|[1-5]\\d\\d)");

    public EvidenceCheck {
        path = blank(path);
        shape = blank(shape) == null ? null : shape.trim().toLowerCase(Locale.ROOT).replace(" ", "");
        rows = blank(rows);
        field = blank(field);
        range = blank(range) == null ? null : range.trim().toLowerCase(Locale.ROOT);
    }

    private static String blank(String s) {
        return s == null || s.isBlank() ? null : s.trim();
    }

    /** Why this check cannot be made, or null when it is fine. */
    public String problem() {
        if (kind == null) {
            return "a check needs a kind: REQUEST_SHAPE, REQUEST_WHEN, ROWS_MATCH_FILTER, ROWS_PRESENT or STATUS";
        }
        return switch (kind) {
            case REQUEST_SHAPE -> !validPath(path) ? "REQUEST_SHAPE needs a request path such as $.branchIds or $.branch*"
                    : shape == null || !MUST_SHAPES.contains(shape) ? "REQUEST_SHAPE needs shape: list, scalar or present" : null;
            case REQUEST_WHEN -> !validPath(path) ? "REQUEST_WHEN needs a request path such as $.branch*"
                    : shape == null || !WHEN_SHAPES.contains(shape) ? "REQUEST_WHEN needs shape: none, one, list, list>=2 or present" : null;
            case ROWS_MATCH_FILTER -> !validPath(rows) || rows.contains("*") ? "ROWS_MATCH_FILTER needs rows: the response list, such as $.payload"
                    : field == null || field.length() > 100 || !FIELD.matcher(field).matches() ? "ROWS_MATCH_FILTER needs field: a row key such as branchId or branch*"
                    : !validPath(path) ? "ROWS_MATCH_FILTER needs path: the request filter, such as $.branch*" : null;
            case ROWS_PRESENT -> !validPath(rows) || rows.contains("*") ? "ROWS_PRESENT needs rows: the response list, such as $.payload"
                    : min != null && (min < 1 || min > 10_000) ? "ROWS_PRESENT min is 1 to 10000" : null;
            case STATUS -> range == null || !RANGE.matcher(range).matches() ? "STATUS needs range: 2xx, 200, !405 or !5xx" : null;
        };
    }

    private static boolean validPath(String p) {
        return p != null && p.length() <= 200 && PATH.matcher(p).matches();
    }

    /** Rows needed before ROWS_PRESENT passes. */
    public int minRows() {
        return min == null ? 1 : min;
    }

    /** One line for people: "request $.branch* can be a list". */
    public String text() {
        return switch (kind) {
            case REQUEST_SHAPE -> "request " + path + switch (shape) {
                case "list" -> " is a list";
                case "scalar" -> " is a single value";
                default -> " is sent";
            };
            case REQUEST_WHEN -> "when request " + path + " is " + switch (shape) {
                case "none" -> "absent, empty or \"all\"";
                case "one" -> "one value";
                case "list>=2" -> "2 or more values";
                case "list" -> "a list";
                default -> "sent";
            };
            case ROWS_MATCH_FILTER -> "every row's " + field + " is in request " + path;
            case ROWS_PRESENT -> "response " + rows + " has " + (minRows() == 1 ? "rows" : "at least " + minRows() + " rows");
            case STATUS -> range.startsWith("!") ? "status not " + range.substring(1) : "status " + range;
        };
    }
}
