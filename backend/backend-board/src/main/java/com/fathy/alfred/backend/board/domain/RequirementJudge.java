package com.fathy.alfred.backend.board.domain;

import com.fasterxml.jackson.databind.JsonNode;
import com.fathy.alfred.backend.board.domain.model.EvidenceCheck;
import com.fathy.alfred.backend.board.domain.model.ItemVerdict.CallResult;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * What one call shows about one Acceptance item (specs/018) - pure, no I/O. In this order:
 * <ol>
 *   <li>REQUEST_SHAPE: what the request must be able to carry. A failure means the call cannot meet the item whatever
 *       the user chose - CONTRADICTS;</li>
 *   <li>REQUEST_WHEN: whether this call exercises the item at all. No match - the call is about another choice and
 *       is not counted ({@link #judge} returns null);</li>
 *   <li>STATUS and ROWS_MATCH_FILTER: what the answer must be - a failure is WRONG;</li>
 *   <li>ROWS_PRESENT: without rows nothing above proves the item - NO_DATA;</li>
 *   <li>anything that could not be read is UNKNOWN; everything held is MEETS.</li>
 * </ol>
 * Never a failure on a guess: an unreadable body, a wildcard naming several keys or a missing response list is
 * UNKNOWN.
 */
public final class RequirementJudge {

    /** What one call showed: the result, and for a failure the check and the value seen. */
    public record Judgement(CallResult result, String reason) {
    }

    private static final Pattern STEP = Pattern.compile("\\.([A-Za-z0-9_\\-]*\\*?)|\\[(\\d+)]");
    private static final int MAX_ROWS = 2000;
    private static final int MAX_SHOWN = 80;

    private RequirementJudge() {
    }

    /**
     * {@code request} / {@code response}: the parsed JSON bodies, null when there is none or it is not JSON.
     * Returns null when the call does not exercise the item.
     */
    public static Judgement judge(List<EvidenceCheck> checks, JsonNode request, JsonNode response, Integer status) {
        List<String> unknown = new ArrayList<>();
        for (EvidenceCheck c : checks) {
            if (c.kind() != EvidenceCheck.Kind.REQUEST_SHAPE) {
                continue;
            }
            Found f = find(request, c.path());
            if (f.unknown != null) {
                unknown.add(c.text() + " - " + f.unknown);
                continue;
            }
            if (!mustHold(c.shape(), f.node)) {
                return new Judgement(CallResult.CONTRADICTS, c.text() + " - sent " + shown(f));
            }
        }
        for (EvidenceCheck c : checks) {
            if (c.kind() != EvidenceCheck.Kind.REQUEST_WHEN) {
                continue;
            }
            Found f = find(request, c.path());
            if (f.unknown != null) {
                unknown.add(c.text() + " - " + f.unknown);
                continue;
            }
            if (!whenHolds(c.shape(), f.node)) {
                return null;
            }
        }
        for (EvidenceCheck c : checks) {
            if (c.kind() == EvidenceCheck.Kind.STATUS && !statusMatches(c.range(), status)) {
                return new Judgement(CallResult.WRONG, c.text() + " - got " + (status == null ? "no answer" : status));
            }
        }
        for (EvidenceCheck c : checks) {
            if (c.kind() != EvidenceCheck.Kind.ROWS_MATCH_FILTER) {
                continue;
            }
            String wrong = rowsMatch(c, request, response, unknown);
            if (wrong != null) {
                return new Judgement(CallResult.WRONG, c.text() + " - " + wrong);
            }
        }
        for (EvidenceCheck c : checks) {
            if (c.kind() != EvidenceCheck.Kind.ROWS_PRESENT) {
                continue;
            }
            Found f = find(response, c.rows());
            if (f.unknown != null || f.node == null || !f.node.isArray()) {
                unknown.add(c.text() + " - " + (f.unknown != null ? f.unknown : "no list at " + c.rows()));
            } else if (f.node.size() < c.minRows()) {
                return unknown.isEmpty() ? new Judgement(CallResult.NO_DATA, c.text() + " - " + f.node.size() + " rows")
                        : new Judgement(CallResult.UNKNOWN, String.join("; ", unknown));
            }
        }
        return unknown.isEmpty() ? new Judgement(CallResult.MEETS, null) : new Judgement(CallResult.UNKNOWN, String.join("; ", unknown));
    }

    // ------------------------------------------------------------------------------------------------------- shapes

    /** Absent, null, empty, or an "all" marker: no restriction. */
    static boolean none(JsonNode n) {
        if (n == null || n.isNull() || n.isMissingNode()) {
            return true;
        }
        if (n.isTextual()) {
            String t = n.asText().strip();
            return t.isEmpty() || t.equalsIgnoreCase("all") || t.equals("*") || t.equals("-1");
        }
        if (n.isNumber()) {
            return n.asLong() == -1;
        }
        if (n.isArray()) {
            if (n.isEmpty()) {
                return true;
            }
            return n.size() == 1 && n.get(0).isValueNode() && none(n.get(0));
        }
        return false;
    }

    private static boolean mustHold(String shape, JsonNode n) {
        return switch (shape) {
            case "list" -> none(n) || n.isArray();
            case "scalar" -> none(n) || n.isValueNode();
            default -> !none(n); // present
        };
    }

    private static boolean whenHolds(String shape, JsonNode n) {
        boolean none = none(n);
        return switch (shape) {
            case "none" -> none;
            case "one" -> !none && (n.isValueNode() || (n.isArray() && n.size() == 1));
            case "list" -> !none && n.isArray();
            case "list>=2" -> !none && n.isArray() && n.size() >= 2;
            default -> !none; // present
        };
    }

    private static boolean statusMatches(String range, Integer status) {
        if (status == null) {
            return false;
        }
        boolean not = range.startsWith("!");
        String r = not ? range.substring(1) : range;
        boolean in = r.endsWith("xx") ? status / 100 == r.charAt(0) - '0' : String.valueOf(status).equals(r);
        return not != in;
    }

    /** The first row whose field is not among the request filter's values, or null when every row matches. */
    private static String rowsMatch(EvidenceCheck c, JsonNode request, JsonNode response, List<String> unknown) {
        Found filter = find(request, c.path());
        if (filter.unknown != null) {
            unknown.add(c.text() + " - " + filter.unknown);
            return null;
        }
        if (none(filter.node)) {
            return null; // no filter: every row matches
        }
        Set<String> allowed = new HashSet<>();
        if (filter.node.isArray()) {
            for (JsonNode v : filter.node) {
                if (v.isValueNode()) {
                    allowed.add(norm(v));
                }
            }
        } else if (filter.node.isValueNode()) {
            allowed.add(norm(filter.node));
        }
        if (allowed.isEmpty()) {
            unknown.add(c.text() + " - the filter is not a list of values");
            return null;
        }
        Found rows = find(response, c.rows());
        if (rows.unknown != null || rows.node == null || !rows.node.isArray()) {
            unknown.add(c.text() + " - " + (rows.unknown != null ? rows.unknown : "no list at " + c.rows()));
            return null;
        }
        int i = 0;
        for (JsonNode row : rows.node) {
            if (i >= MAX_ROWS) {
                break;
            }
            Found v = field(row, c.field());
            if (v.unknown != null) {
                unknown.add(c.text() + " - row " + i + ": " + v.unknown);
                return null;
            }
            if (v.node == null || !v.node.isValueNode() || !allowed.contains(norm(v.node))) {
                return "row " + i + " has " + c.field() + " " + (v.node == null ? "absent" : clip(v.node.toString()))
                        + ", the request asked for " + clip(filter.node.toString());
            }
            i++;
        }
        return null;
    }

    private static String norm(JsonNode v) {
        if (v.isNumber()) {
            return v.decimalValue().stripTrailingZeros().toPlainString();
        }
        String t = v.asText().strip();
        if (t.matches("-?\\d+(\\.\\d+)?")) {
            return new java.math.BigDecimal(t).stripTrailingZeros().toPlainString();
        }
        return t.toLowerCase(Locale.ROOT);
    }

    // -------------------------------------------------------------------------------------------------------- paths

    /** A path's node, or why it cannot be told; a missing key is a null node (absent), not unknown. */
    record Found(JsonNode node, String unknown, String key) {
    }

    static Found find(JsonNode root, String path) {
        if (root == null) {
            return new Found(null, "no JSON body", null);
        }
        String steps = path.substring(1);
        Matcher m = STEP.matcher(steps);
        JsonNode node = root;
        String key = null;
        int pos = 0;
        while (m.find()) {
            if (m.start() != pos) {
                return new Found(null, "bad path " + path, null);
            }
            pos = m.end();
            if (node == null || node.isNull()) {
                return new Found(null, null, key); // a parent is absent: so is the value
            }
            if (m.group(1) != null) {
                String name = m.group(1);
                if (name.endsWith("*")) {
                    Found f = field(node, name);
                    if (f.unknown != null) {
                        return f;
                    }
                    node = f.node;
                    key = f.key;
                } else {
                    if (!node.isObject()) {
                        return new Found(null, path + " is not an object", null);
                    }
                    node = node.get(name);
                    key = name;
                }
            } else {
                if (!node.isArray()) {
                    return new Found(null, path + " is not a list", null);
                }
                node = node.get(Integer.parseInt(m.group(2)));
            }
        }
        if (pos != steps.length()) {
            return new Found(null, "bad path " + path, null);
        }
        return new Found(node, null, key);
    }

    /** A key of an object, {@code prefix*} matching the one key that starts so (case-blind). */
    static Found field(JsonNode obj, String name) {
        if (obj == null || !obj.isObject()) {
            return new Found(null, "not an object", null);
        }
        if (!name.endsWith("*")) {
            return new Found(obj.get(name), null, name);
        }
        String prefix = name.substring(0, name.length() - 1).toLowerCase(Locale.ROOT);
        String hit = null;
        Iterator<String> names = obj.fieldNames();
        while (names.hasNext()) {
            String k = names.next();
            if (k.toLowerCase(Locale.ROOT).startsWith(prefix)) {
                if (hit != null) {
                    return new Found(null, name + " matches both " + hit + " and " + k, null);
                }
                hit = k;
            }
        }
        return new Found(hit == null ? null : obj.get(hit), null, hit);
    }

    private static String shown(Found f) {
        String value = f.node == null ? "nothing" : clip(f.node.toString());
        return f.key == null ? value : f.key + ": " + value;
    }

    private static String clip(String s) {
        return s.length() > MAX_SHOWN ? s.substring(0, MAX_SHOWN) + "…" : s;
    }
}
