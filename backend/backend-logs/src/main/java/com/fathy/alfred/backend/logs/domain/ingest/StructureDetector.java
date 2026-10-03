package com.fathy.alfred.backend.logs.domain.ingest;

import com.fathy.alfred.backend.logs.domain.model.DataView;
import com.fathy.alfred.backend.logs.domain.model.FieldDef;
import com.fathy.alfred.backend.logs.domain.model.FieldType;
import com.fathy.alfred.backend.logs.domain.model.GroupLevel;
import com.fathy.alfred.backend.logs.domain.model.LogStructure;
import com.fathy.alfred.backend.logs.domain.model.Role;
import com.fathy.alfred.backend.logs.domain.model.SearchMode;
import com.fathy.alfred.backend.logs.domain.model.TypeSource;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Collectors;

/**
 * Builds a structure from a sample of flattened lines (research §R5): field paths, a type per field
 * (the first of datetime/date/boolean/number matching at least 95 % of the sampled values, else
 * string), role and search-mode guesses, a default template, and duplicate marking for JSON-in-text
 * that repeats another subtree. The sample may mix structures: the field list is every field any
 * sampled line has, and a role also goes to a second field that never appears in the same line as
 * the first (the same meaning under another name in another structure).
 */
public final class StructureDetector {

    public static final int SAMPLE_LINES = 1_000;
    static final double TYPE_THRESHOLD = 0.95;
    /** An unpacked JSON-in-text subtree is a duplicate when this share of its leaves equal another subtree. */
    static final double DUPLICATE_THRESHOLD = 0.9;
    /** Average text length above which a string field defaults to fragment (Text) search. */
    static final int LONG_TEXT = 40;
    private static final String DEFAULT_ZONE = "UTC";
    /** "Few distinct values": at most this many, or this share of the sampled values. */
    static final int LOW_CARDINALITY_MIN = 50;
    static final double LOW_CARDINALITY_SHARE = 0.2;

    private StructureDetector() {
    }

    public static LogStructure detect(List<Flattener.Result> sample) {
        Map<String, List<Object>> values = new LinkedHashMap<>();
        Set<String> unpackedRoots = new LinkedHashSet<>();
        for (Flattener.Result r : sample) {
            r.values().forEach((p, v) -> values.computeIfAbsent(p, k -> new ArrayList<>()).add(v));
            unpackedRoots.addAll(r.unpackedRoots());
        }
        Map<String, String> duplicates = duplicates(sample, unpackedRoots, values.keySet());
        // Field caps: past them a field stays in the raw line and the JSON view only (counted).
        int stored = 0;
        List<String> overflow = new ArrayList<>();
        Map<String, List<Object>> kept = new LinkedHashMap<>();
        for (var e : values.entrySet()) {
            boolean dup = duplicates.containsKey(e.getKey());
            if (kept.size() >= LogStructure.MAX_FIELDS || (!dup && stored >= LogStructure.MAX_STORED_FIELDS)) {
                if (overflow.size() < LogStructure.MAX_OVERFLOW_LISTED) {
                    overflow.add(e.getKey());
                }
                continue;
            }
            stored += dup ? 0 : 1;
            kept.put(e.getKey(), e.getValue());
        }
        Map<String, String> labels = labels(kept.keySet(), duplicates.keySet());

        List<FieldDef> fields = new ArrayList<>();
        int index = 0;
        for (var e : kept.entrySet()) {
            fields.add(field(index++, e.getKey(), labels.get(e.getKey()), e.getValue(), duplicates.get(e.getKey())));
        }
        fields = assignRoles(fields, sample);
        return new LogStructure(structureId(kept.keySet()), fields, List.of(),
                defaultTemplate(fields), List.of(), DataView.TABLE, DEFAULT_ZONE, overflow);
    }

    /** A new path seen after the sample: typed by its first value, never a duplicate, no role. */
    public static FieldDef newField(int index, String path, String label, Object firstValue, long lineNumber) {
        FieldDef f = field(index, path, label, firstValue == null ? List.of() : List.of(firstValue), null);
        return new FieldDef(f.index(), f.path(), f.label(), f.type(), f.typeSource(), f.format(), f.matchRate(),
                f.invalidCount(), f.suggestBoolean(), f.searchMode(), null, false, null, lineNumber, f.sample());
    }

    public static String structureId(Collection<String> paths) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(String.join("\n", new TreeSet<>(paths)).getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest, 0, 6);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /**
     * Shortest dot-segment suffix of each path that no other stored path shares; duplicates (never
     * typed into pills) keep their full path so they never steal a short label.
     */
    public static Map<String, String> labels(Collection<String> paths, Set<String> duplicatePaths) {
        Map<String, String> out = new LinkedHashMap<>();
        List<String> stored = paths.stream().filter(p -> !duplicatePaths.contains(p)).toList();
        for (String p : stored) {
            out.put(p, shortestUniqueSuffix(p, stored, out.values()));
        }
        for (String p : paths) {
            out.putIfAbsent(p, p);
        }
        return out;
    }

    public static String shortestUniqueSuffix(String path, Collection<String> all, Collection<String> taken) {
        String[] seg = path.split("\\.");
        for (int n = 1; n <= seg.length; n++) {
            String suffix = String.join(".", java.util.Arrays.copyOfRange(seg, seg.length - n, seg.length));
            boolean clash = taken.contains(suffix) || all.stream()
                    .anyMatch(o -> !o.equals(path) && (o.equals(suffix) || o.endsWith("." + suffix)));
            if (!clash) {
                return suffix;
            }
        }
        return path;
    }

    private static FieldDef field(int index, String path, String label, List<Object> vals, String duplicateOf) {
        List<Object> present = vals.stream().filter(Objects::nonNull).toList();
        int n = Math.max(1, present.size());
        double dt = present.stream().filter(ValueTyper::looksIsoDatetime).count() / (double) n;
        double d = present.stream().filter(ValueTyper::looksIsoDate).count() / (double) n;
        double b = present.stream().filter(v -> v instanceof Boolean).count() / (double) n;
        double num = present.stream().filter(ValueTyper::looksNumber).count() / (double) n;
        FieldType type = FieldType.STRING;
        double rate = 1;
        if (!present.isEmpty()) {
            if (dt >= TYPE_THRESHOLD) {
                type = FieldType.DATETIME;
                rate = dt;
            } else if (d >= TYPE_THRESHOLD) {
                type = FieldType.DATE;
                rate = d;
            } else if (b >= TYPE_THRESHOLD) {
                type = FieldType.BOOLEAN;
                rate = b;
            } else if (num >= TYPE_THRESHOLD) {
                type = FieldType.NUMBER;
                rate = num;
            }
        }
        boolean zeroOne = type == FieldType.NUMBER && !present.isEmpty()
                && present.stream().allMatch(v -> "0".equals(v.toString()) || "1".equals(v.toString()));
        double avgLen = present.stream().mapToInt(v -> v.toString().length()).average().orElse(0);
        // Every Exact field is one more index updated on every insert, so only fields worth filtering
        // by value default to Exact: few distinct values (levels, services, status codes, flags).
        // Unique-ish values (ids, timestamps) default to Not searched - still filterable, just a scan -
        // and roles below upgrade the ones that matter (time, correlation, ...). The user decides.
        long distinct = present.stream().map(Object::toString).distinct().count();
        boolean lowCardinality = distinct <= Math.max(LOW_CARDINALITY_MIN, present.size() * LOW_CARDINALITY_SHARE);
        SearchMode search = duplicateOf != null ? SearchMode.NONE
                : type == FieldType.STRING && avgLen > LONG_TEXT ? SearchMode.TEXT
                : lowCardinality && type != FieldType.DATETIME ? SearchMode.EXACT : SearchMode.NONE;
        String format = switch (type) {
            case DATETIME -> "ISO-8601 · UTC";
            case DATE -> "yyyy-MM-dd · UTC";
            case BOOLEAN -> "true = true · false = false";
            default -> "";
        };
        String sample = present.isEmpty() ? null : truncateSample(present.get(0).toString());
        long invalid = Math.round((1 - rate) * present.size());
        return new FieldDef(index, path, label, type, TypeSource.AUTO, format, rate, invalid, zeroOne,
                search, null, false, duplicateOf, 0, sample);
    }

    /** The sample is only a preview in the structure editor; the stored data is never shortened. */
    private static String truncateSample(String s) {
        return s.length() > 200 ? s.substring(0, 200) + "…" : s;
    }

    /** Number of distinct field sets in a sample: "3 structures in 1,000 sampled lines". */
    public static int structureCount(List<Flattener.Result> sample) {
        ShapeMatcher m = new ShapeMatcher(List.of());
        Map<String, Integer> idx = new HashMap<>();
        for (Flattener.Result r : sample) {
            m.assign(r.values().keySet().stream().map(p -> idx.computeIfAbsent(p, k -> idx.size())).toList());
        }
        return m.all().size();
    }

    private static List<FieldDef> assignRoles(List<FieldDef> fields, List<Flattener.Result> sample) {
        Map<Role, List<String>> wanted = new EnumMap<>(Role.class);
        wanted.put(Role.TIME, List.of("@timestamp", "timestamp", "time", "ts", "date"));
        wanted.put(Role.LEVEL, List.of("log.level", "level", "severity", "loglevel"));
        wanted.put(Role.CORRELATION, List.of("correlationid", "traceid", "trace_id", "requestid", "sessionid"));
        wanted.put(Role.MESSAGE, List.of("message", "msg"));
        wanted.put(Role.SERVICE, List.of("externalservice", "service", "service.name"));
        wanted.put(Role.DURATION, List.of("timetaken", "duration", "elapsed", "took"));
        wanted.put(Role.STATUS, List.of("statuscode", "status", "httpstatus"));
        wanted.put(Role.ERROR, List.of("error", "exception", "stacktrace"));
        wanted.put(Role.REQUEST_BODY, List.of("request", "requestbody"));
        wanted.put(Role.RESPONSE_BODY, List.of("response", "responsebody"));

        Map<Integer, Role> chosen = new HashMap<>();
        Map<Integer, Integer> rank = new HashMap<>();
        for (var e : wanted.entrySet()) {
            List<FieldDef> picked = new ArrayList<>();
            for (String name : e.getValue()) {
                for (FieldDef f : fields) {
                    String last = f.label().toLowerCase(Locale.ROOT);
                    String lastSeg = last.contains(".") && !name.contains(".") ? last.substring(last.lastIndexOf('.') + 1) : last;
                    if (f.stored() && !chosen.containsKey(f.index()) && (last.equals(name) || lastSeg.equals(name))
                            && roleFits(e.getKey(), f) && (picked.isEmpty() || neverTogether(f, picked, sample))) {
                        chosen.put(f.index(), e.getKey());
                        picked.add(f);
                        rank.put(f.index(), picked.size());
                    }
                }
            }
        }
        return fields.stream().map(f -> {
            Role r = chosen.get(f.index());
            if (r == null) {
                return f;
            }
            SearchMode s = r == Role.MESSAGE || r == Role.ERROR || r == Role.REQUEST_BODY || r == Role.RESPONSE_BODY
                    ? SearchMode.TEXT : SearchMode.EXACT;
            return f.withSearchMode(s).withRole(r, rank.get(f.index()));
        }).collect(Collectors.toList());
    }

    /** True when no sampled line has {@code f} together with any of {@code others}: an alternate name, not a second value. */
    private static boolean neverTogether(FieldDef f, List<FieldDef> others, List<Flattener.Result> sample) {
        for (Flattener.Result r : sample) {
            if (r.values().get(f.path()) == null) {
                continue;
            }
            for (FieldDef o : others) {
                if (r.values().get(o.path()) != null) {
                    return false;
                }
            }
        }
        return true;
    }

    private static boolean roleFits(Role role, FieldDef f) {
        return switch (role) {
            case TIME -> f.type() == FieldType.DATETIME || f.type() == FieldType.NUMBER;
            case DURATION -> f.type() == FieldType.NUMBER;
            default -> true;
        };
    }

    /** "{message} · {externalService}" built from roles, so a fresh source already reads well. */
    private static String defaultTemplate(List<FieldDef> fields) {
        List<String> parts = new ArrayList<>();
        for (Role r : List.of(Role.MESSAGE, Role.SERVICE, Role.STATUS)) {
            fields.stream().filter(f -> f.role() == r).findFirst().ifPresent(f -> parts.add("{" + f.label() + "}"));
        }
        fields.stream().filter(f -> f.label().equalsIgnoreCase("methodName")).findFirst()
                .ifPresent(f -> parts.add(0, "{" + f.label() + "}"));
        if (parts.isEmpty()) {
            fields.stream().filter(f -> f.stored() && f.type() == FieldType.STRING && f.role() == null).limit(3)
                    .forEach(f -> parts.add("{" + f.label() + "}"));
        }
        return String.join(" · ", parts);
    }

    /**
     * For each unpacked JSON-in-text root U, finds another subtree R whose leaves equal U's leaves
     * (same relative path, same value) in at least {@link #DUPLICATE_THRESHOLD} of the sample;
     * every path under U is then marked {@code duplicateOf} R's matching path.
     */
    static Map<String, String> duplicates(List<Flattener.Result> sample, Set<String> unpackedRoots, Set<String> allPaths) {
        Map<String, String> out = new HashMap<>();
        for (String root : unpackedRoots) {
            String prefix = root + ".";
            List<String> leaves = allPaths.stream().filter(p -> p.startsWith(prefix)).toList();
            if (leaves.isEmpty()) {
                continue;
            }
            String rel0 = leaves.get(0).substring(prefix.length());
            for (String candidate : allPaths) {
                if (candidate.startsWith(prefix) || !(candidate.equals(rel0) || candidate.endsWith("." + rel0))) {
                    continue;
                }
                String other = candidate.length() == rel0.length() ? "" : candidate.substring(0, candidate.length() - rel0.length());
                long equal = 0;
                long total = 0;
                for (Flattener.Result r : sample) {
                    for (String leaf : leaves) {
                        if (!r.values().containsKey(leaf)) {
                            continue;
                        }
                        total++;
                        Object a = r.values().get(leaf);
                        Object b = r.values().get(other + leaf.substring(prefix.length()));
                        if (a != null && b != null && a.toString().equals(b.toString())) {
                            equal++;
                        }
                    }
                }
                if (total > 0 && equal >= DUPLICATE_THRESHOLD * total) {
                    for (String leaf : leaves) {
                        out.put(leaf, other + leaf.substring(prefix.length()));
                    }
                    break;
                }
            }
        }
        return out;
    }

    /** The group levels a line carries, used to keep {@link GroupLevel}s pointing at real fields. */
    public static List<GroupLevel> validLevels(LogStructure s, List<GroupLevel> levels) {
        return levels.stream().filter(l -> s.byLabel(l.fieldLabel()).isPresent()).toList();
    }
}
