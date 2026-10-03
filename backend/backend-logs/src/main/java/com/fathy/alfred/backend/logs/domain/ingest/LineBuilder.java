package com.fathy.alfred.backend.logs.domain.ingest;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.logs.domain.model.FieldDef;
import com.fathy.alfred.backend.logs.domain.model.GroupLevel;
import com.fathy.alfred.backend.logs.domain.model.LineRecord;
import com.fathy.alfred.backend.logs.domain.model.LogStructure;
import com.fathy.alfred.backend.logs.domain.model.Role;
import com.fathy.alfred.backend.logs.domain.model.SearchMode;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Turns one raw line into a {@link LineRecord} (research §R4), in two steps so new fields can be
 * registered in between: {@link #parse} (JSON, flatten, new paths) and {@link #toRecord}
 * (typed values, time, level, group placement, pattern, structure, trigram text). Every line may have
 * its own structure: whatever fields it has are registered, none is held back.
 */
public final class LineBuilder {

    /** Lines bigger than this are kept as unparsed text rather than parsed into fields. */
    public static final int MAX_PARSED_BYTES = 16 * 1024 * 1024;

    private final ObjectMapper mapper;
    private final Flattener flattener;

    public LineBuilder(ObjectMapper mapper) {
        this.mapper = mapper;
        this.flattener = new Flattener(mapper);
    }

    /**
     * @param values   flattened fields; empty when unparsed
     * @param raw      the line as text (re-serialised when redaction changed it)
     * @param newPaths paths this structure does not have yet
     */
    public record Parsed(Map<String, Object> values, String raw, boolean unparsed, Map<String, Object> newPaths) {
    }

    public Parsed parse(byte[] bytes, LogStructure structure, boolean redactAtLoad) {
        String raw = new String(bytes, StandardCharsets.UTF_8);
        if (bytes.length > MAX_PARSED_BYTES) {
            return new Parsed(Map.of(), raw, true, Map.of());
        }
        JsonNode node;
        try {
            node = mapper.readTree(raw);
        } catch (Exception e) {
            return new Parsed(Map.of(), raw, true, Map.of());
        }
        if (node == null || !node.isObject()) {
            return new Parsed(Map.of(), raw, true, Map.of());
        }
        if (redactAtLoad) {
            Set<String> sensitive = structure.fields().stream().filter(FieldDef::sensitive).map(FieldDef::path).collect(Collectors.toSet());
            if (Redactor.redact(node, sensitive)) {
                raw = node.toString();
            }
        }
        Map<String, Object> values = flattener.flatten(node, payloadSet(structure)).values();
        Set<String> known = structure.fields().stream().map(FieldDef::path).collect(Collectors.toSet());
        known.addAll(structure.overflowPaths());
        Map<String, Object> fresh = new LinkedHashMap<>();
        values.forEach((p, v) -> {
            if (!known.contains(p)) {
                fresh.put(p, v);
            }
        });
        return new Parsed(values, raw, false, fresh);
    }

    /** The structure's payload paths as a set, built once per structure version (parse runs per line). */
    private static Set<String> payloadSet(LogStructure s) {
        if (s.payloadPaths().isEmpty()) {
            return Set.of();
        }
        return PAYLOADS.computeIfAbsent(s.payloadPaths(), java.util.HashSet::new);
    }

    private static final Map<List<String>, Set<String>> PAYLOADS = new java.util.concurrent.ConcurrentHashMap<>() {
        @Override
        public Set<String> computeIfAbsent(List<String> key, java.util.function.Function<? super List<String>, ? extends Set<String>> f) {
            if (size() > 256) {
                clear(); // one entry per structure version; bounded
            }
            return super.computeIfAbsent(key, f);
        }
    };

    /**
     * @param lastTs time of the previous line, used when this line has no time of its own (keeps file order)
     * @param miner  this source's pattern miner (single ingest thread per source)
     * @param shapes this source's structure matcher, or null to leave the structure unset
     */
    public LineRecord toRecord(Parsed p, LogStructure s, String lineId, String inputId, long byteOffset, boolean copyRaw,
                               long lastTs, PatternMiner miner, List<PatternMiner.Cluster> changedPatterns, ShapeMatcher shapes) {
        int bytes = p.raw().getBytes(StandardCharsets.UTF_8).length;
        if (p.unparsed()) {
            return new LineRecord(lineId, inputId, byteOffset, lastTs, null, 0, "", null, 0, 0, Map.of(), Map.of(), null,
                    copyRaw ? p.raw() : null, true, 0, bytes);
        }
        Map<Integer, String> text = new HashMap<>();
        Map<Integer, Object> typed = new HashMap<>();
        List<String> fts = new ArrayList<>();
        for (FieldDef f : s.fields()) {
            if (!f.stored() || !p.values().containsKey(f.path())) {
                continue;
            }
            Object v = p.values().get(f.path());
            if (v == null) {
                continue;
            }
            String t = String.valueOf(v);
            text.put(f.index(), t);
            if (f.typed()) {
                ValueTyper.convert(v, f.type(), f.format()).ifPresent(x -> typed.put(f.index(), x));
            }
            if (f.searchMode() == SearchMode.TEXT) {
                fts.add(t);
            }
        }
        Derived d = derive(s, p.values(), lastTs, miner, changedPatterns);
        int shape = shapes == null ? 0 : shapes.assign(text.keySet());
        return new LineRecord(lineId, inputId, byteOffset, d.ts(), d.level(), d.placement().level(), d.placement().path(),
                missingLabel(s, d.placement()), d.patternId(), d.duration(), text, typed, String.join("\n", fts),
                copyRaw ? p.raw() : null, false, shape, bytes);
    }

    public record Derived(long ts, String level, GroupKeyer.Placement placement, long patternId, double duration) {
    }

    /**
     * Everything that depends on roles and levels; also used to recompute after the user changes them.
     * A role may list several fields (lines of different structures name the same thing differently):
     * each line uses the first of them that it has and that converts.
     */
    public static Derived derive(LogStructure s, Map<String, Object> values, long lastTs, PatternMiner miner,
                                 List<PatternMiner.Cluster> changedPatterns) {
        long ts = firstTyped(s, Role.TIME, values).map(o -> ((Number) o).longValue()).orElse(lastTs);
        String level = first(s, Role.LEVEL, values).map(LineBuilder::normalizeLevel).orElse(null);
        double duration = firstTyped(s, Role.DURATION, values).map(o -> ((Number) o).doubleValue()).orElse(0d);
        List<String> ids = new ArrayList<>();
        for (GroupLevel gl : s.groupLevels()) {
            Object v = s.byLabel(gl.fieldLabel()).map(f -> values.get(f.path())).orElse(null);
            ids.add(v == null ? null : String.valueOf(v));
        }
        GroupKeyer.Placement placement = GroupKeyer.place(ids);
        long patternId = 0;
        if (miner != null) {
            String message = first(s, Role.MESSAGE, values).map(String::valueOf).orElse("");
            PatternMiner.Cluster c = miner.add(message);
            patternId = c.id();
            if (c.changed()) {
                changedPatterns.add(c);
                c.clearChanged();
            }
        }
        return new Derived(ts, level, placement, patternId, duration);
    }

    /** The value of the first field of {@code role} that this line has. */
    public static Optional<Object> first(LogStructure s, Role role, Map<String, Object> values) {
        for (FieldDef f : s.rolesOf(role)) {
            Object v = values.get(f.path());
            if (v != null) {
                return Optional.of(v);
            }
        }
        return Optional.empty();
    }

    private static Optional<Object> firstTyped(LogStructure s, Role role, Map<String, Object> values) {
        for (FieldDef f : s.rolesOf(role)) {
            Optional<Object> v = ValueTyper.convert(values.get(f.path()), f.type(), f.format());
            if (v.isPresent()) {
                return v;
            }
        }
        return Optional.empty();
    }

    public static String missingLabel(LogStructure s, GroupKeyer.Placement p) {
        return p.missingLevel() < 0 ? null : s.groupLevels().get(p.missingLevel()).fieldLabel();
    }

    static String normalizeLevel(Object v) {
        if (v == null) {
            return null;
        }
        String l = String.valueOf(v).trim().toUpperCase(Locale.ROOT);
        return switch (l) {
            case "WARNING" -> "WARN";
            case "ERR", "FATAL", "SEVERE", "CRITICAL" -> "ERROR";
            case "INFORMATION" -> "INFO";
            case "TRACE", "FINE", "FINER", "FINEST" -> "DEBUG";
            default -> l;
        };
    }

    /** Re-flattens a stored raw line (lines stored before every field of every line was registered). */
    public Map<String, Object> flattenRaw(String raw) {
        try {
            JsonNode node = mapper.readTree(raw);
            return node != null && node.isObject() ? flattener.flatten(node).values() : Map.of();
        } catch (Exception e) {
            return Map.of();
        }
    }
}
