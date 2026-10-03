package com.fathy.alfred.backend.logs.domain.ingest;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Decides which parts of a line are payloads - a request/response body, a bean dump - to keep as ONE
 * text field instead of one field per leaf (payload option A, the OpenSearch "flattened" idea). Without
 * it a single detail.log line turned into ~900 fields: SQLite's column budget ran out, every line became
 * very wide, the backend ran out of memory and lines split into dozens of "structures".
 *
 * <p>A part is a payload when (1) it has more than {@link #PAYLOAD_FIELDS} leaf fields of its own (not
 * counting leaves already inside a deeper payload), or (2) its keys look like data rather than names
 * (ids, numbers, base64) - e.g. {@code priceClasses.R2FsaWxl….fareType}. The deepest such part wins, so
 * siblings such as {@code message.context.externalService} stay ordinary fields. A part holding a field
 * the user relies on (a role, a grouping level, a column, a template token) is never a payload.
 */
public final class PayloadRule {

    public static final int PAYLOAD_FIELDS = 50;
    private static final Pattern NUMBER = Pattern.compile("^\\d+$");
    private static final Pattern UUID = Pattern.compile("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");
    private static final Pattern HEX = Pattern.compile("^[0-9a-fA-F]{16,}$");
    private static final Pattern BASE64ISH = Pattern.compile("^[A-Za-z0-9+/_=-]{16,}$");

    private PayloadRule() {
    }

    /** A key that is a value: an index, an id, a uuid, a hash, base64. */
    static boolean idLike(String segment) {
        if (NUMBER.matcher(segment).matches() || UUID.matcher(segment).matches() || HEX.matcher(segment).matches()) {
            return true;
        }
        if (!BASE64ISH.matcher(segment).matches()) {
            return false;
        }
        boolean digit = segment.chars().anyMatch(Character::isDigit);
        boolean upper = segment.chars().anyMatch(Character::isUpperCase);
        boolean lower = segment.chars().anyMatch(Character::isLowerCase);
        return segment.endsWith("=") || (digit && upper && lower);
    }

    /**
     * New payload prefixes for these leaf paths, given the ones already chosen. Paths already under a
     * known payload are ignored; a top-level key is never a payload (it would swallow everything).
     */
    public static Set<String> choose(Collection<String> paths, Collection<String> known) {
        return choose(paths, known, List.of());
    }

    /** @param kept paths that must stay separate fields: no part containing one of them is chosen */
    public static Set<String> choose(Collection<String> paths, Collection<String> known, Collection<String> kept) {
        Set<String> chosen = new LinkedHashSet<>();
        List<String> open = new ArrayList<>();
        for (String p : paths) {
            if (!under(p, known)) {
                open.add(p);
            }
        }
        // (2) data-like keys: the part holding them is a payload.
        for (String p : open) {
            String[] seg = p.split("\\.");
            for (int i = 1; i < seg.length; i++) {
                if (idLike(seg[i])) {
                    String parent = String.join(".", java.util.Arrays.copyOfRange(seg, 0, i));
                    if (!holdsKept(parent, kept)) {
                        chosen.add(parent);
                    }
                    break;
                }
            }
        }
        // (1) big parts, deepest first, each counting only leaves not already inside a chosen payload.
        Map<String, Integer> depth = new HashMap<>();
        for (String p : open) {
            String[] seg = p.split("\\.");
            for (int i = 2; i < seg.length; i++) { // ancestors below the top-level key
                depth.putIfAbsent(String.join(".", java.util.Arrays.copyOfRange(seg, 0, i)), i);
            }
        }
        List<String> byDepth = new ArrayList<>(depth.keySet());
        byDepth.sort(Comparator.comparingInt((String x) -> depth.get(x)).reversed());
        for (String prefix : byDepth) {
            if (under(prefix, chosen) || chosen.contains(prefix) || holdsKept(prefix, kept)) {
                continue;
            }
            int leaves = 0;
            for (String p : open) {
                if (p.startsWith(prefix + ".") && !under(p, chosen)) {
                    leaves++;
                }
            }
            if (leaves > PAYLOAD_FIELDS) {
                chosen.add(prefix);
            }
        }
        // Keep only the outermost of nested choices.
        Set<String> out = new LinkedHashSet<>();
        for (String c : chosen) {
            if (!under(c, chosen) && !known.contains(c)) {
                out.add(c);
            }
        }
        return out;
    }

    private static boolean holdsKept(String prefix, Collection<String> kept) {
        for (String k : kept) {
            if (k.equals(prefix) || k.startsWith(prefix + ".")) {
                return true;
            }
        }
        return false;
    }

    /** Roles whose field IS a body: always one field, never split into its leaves. */
    public static boolean bodyRole(com.fathy.alfred.backend.logs.domain.model.Role role) {
        return role == com.fathy.alfred.backend.logs.domain.model.Role.REQUEST_BODY
                || role == com.fathy.alfred.backend.logs.domain.model.Role.RESPONSE_BODY
                || role == com.fathy.alfred.backend.logs.domain.model.Role.ERROR;
    }

    /** Body-role paths that have leaves below them in {@code paths} (only those need collapsing). */
    public static Set<String> bodies(Collection<String> bodyPaths, Collection<String> paths, Collection<String> known) {
        Set<String> out = new LinkedHashSet<>();
        for (String b : bodyPaths) {
            if (!known.contains(b) && !under(b, known) && paths.stream().anyMatch(p -> p.startsWith(b + "."))) {
                out.add(b);
            }
        }
        return out;
    }

    /** True when {@code path} is strictly inside one of {@code prefixes}. */
    public static boolean under(String path, Collection<String> prefixes) {
        for (String pre : prefixes) {
            if (path.startsWith(pre + ".")) {
                return true;
            }
        }
        return false;
    }

    /** Paths that are not inside a payload, plus the payload prefixes themselves (each becomes one field). */
    public static Set<String> collapse(Collection<String> paths, Collection<String> payloads) {
        Set<String> out = new LinkedHashSet<>();
        Set<String> pre = new HashSet<>(payloads);
        for (String p : paths) {
            String hit = null;
            for (String x : pre) {
                if (p.startsWith(x + ".")) {
                    hit = x;
                    break;
                }
            }
            out.add(hit == null ? p : hit);
        }
        return out;
    }
}
