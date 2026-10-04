package com.fathy.alfred.backend.logs.adapter.out.sqlite;

import com.fathy.alfred.backend.logs.domain.ingest.LineBuilder;
import com.fathy.alfred.backend.logs.domain.ingest.ValueTyper;
import com.fathy.alfred.backend.logs.domain.model.FieldDef;
import com.fathy.alfred.backend.logs.domain.model.FieldType;
import com.fathy.alfred.backend.logs.domain.model.LogQuery;
import com.fathy.alfred.backend.logs.domain.model.LogStructure;
import com.fathy.alfred.backend.logs.domain.model.Role;
import com.fathy.alfred.backend.logs.domain.model.SearchMode;

import java.util.ArrayList;
import java.util.List;
import java.util.stream.Collectors;

/**
 * {@link LogQuery} → a parameterised SQL condition over one source's line table
 * (contracts/log-query.md "SQLite translation"). User text only ever travels as a bind parameter;
 * field labels are resolved through the structure to column names this class builds itself.
 */
final class SqliteLogQueryTranslator {

    /** Fragment search needs at least a trigram; shorter terms fall back to LIKE (and say so). */
    static final int MIN_FTS_TERM = 3;

    record Sql(String where, List<Object> params, boolean slow) {

        static Sql of(String where, List<Object> params) {
            return new Sql(where, params, false);
        }
    }

    private SqliteLogQueryTranslator() {
    }

    static String text(FieldDef f) {
        return "f" + f.index();
    }

    static String typedCol(FieldDef f) {
        return "t" + f.index();
    }

    /** The column filters and sorts use: the typed shadow for typed fields, else the original text. */
    static String valueCol(FieldDef f) {
        return f.typed() ? typedCol(f) : text(f);
    }

    /**
     * The level role's first field: what the list shows as Level, what the histogram and minimap count.
     * Filters, sidebar counts and sorts on it use the line's level (that field, or the role's next field
     * a line has; normalised: WARNING = WARN, FATAL = ERROR), so `level:ERROR` matches what the
     * histogram shows as ERROR. Its other fields keep their own values.
     */
    static boolean isLevelField(LogStructure s, FieldDef f) {
        return s != null && f.role() == Role.LEVEL && s.byRole(Role.LEVEL).map(x -> x.path().equals(f.path())).orElse(false);
    }

    /** The column a filter, sidebar count or sort reads for this field. */
    static String filterCol(LogStructure s, FieldDef f, boolean typed) {
        if (isLevelField(s, f)) {
            return "level";
        }
        return typed ? valueCol(f) : text(f);
    }

    /** WHERE body (never empty: "1=1" when unfiltered) for pills + time range; no cursor. */
    static Sql where(String sourceId, LogStructure s, LogQuery q) {
        List<String> parts = new ArrayList<>();
        List<Object> params = new ArrayList<>();
        boolean slow = false;
        if (q.from() != null) {
            parts.add("ts_ms >= ?");
            params.add(q.from());
        }
        if (q.to() != null) {
            parts.add("ts_ms <= ?");
            params.add(q.to());
        }
        // Consecutive filters joined by "or" are one group (any of them); groups are ANDed.
        List<List<LogQuery.Pill>> groups = new ArrayList<>();
        for (LogQuery.Pill p : q.pills() == null ? List.<LogQuery.Pill>of() : q.pills()) {
            if (p.orWithPrevious() && !groups.isEmpty()) {
                groups.get(groups.size() - 1).add(p);
            } else {
                groups.add(new ArrayList<>(List.of(p)));
            }
        }
        for (List<LogQuery.Pill> g : groups) {
            List<String> any = new ArrayList<>();
            for (LogQuery.Pill p : g) {
                Sql one = negatable(sourceId, s, p);
                any.add("(" + one.where() + ")");
                params.addAll(one.params());
                slow |= one.slow();
            }
            parts.add("(" + String.join(" OR ", any) + ")");
        }
        return new Sql(parts.isEmpty() ? "1=1" : String.join(" AND ", parts), params, slow);
    }

    /** A pill list as one boolean expression (used for the minimap's condition). */
    static Sql condition(String sourceId, LogStructure s, List<LogQuery.Pill> pills) {
        return where(sourceId, s, new LogQuery(pills, null, null, null, null, 0));
    }

    /**
     * A filter, or its opposite when it "filters out". The opposite keeps lines the filter cannot judge (no such
     * field: its condition is NULL), the way NEQ / NOT_EXISTS always have.
     */
    static Sql negatable(String sourceId, LogStructure s, LogQuery.Pill p) {
        Sql one = pill(sourceId, s, p);
        if (!p.negated()) {
            return one;
        }
        return new Sql("NOT coalesce((" + one.where() + "), 0)", one.params(), one.slow());
    }

    static Sql pill(String sourceId, LogStructure s, LogQuery.Pill p) {
        if (isStructurePill(s, p)) {
            int id = structureId(p.value());
            return p.op() == LogQuery.Op.EQ ? Sql.of("shape = ?", List.of(id)) : Sql.of("shape IS NULL OR shape <> ?", List.of(id));
        }
        return switch (p.op()) {
            case TEXT -> text(sourceId, s, p.value());
            case SELECTION -> Sql.of("line_id IN (" + p.lineIds().stream().map(x -> "?").collect(Collectors.joining(",")) + ")",
                    new ArrayList<>(p.lineIds()));
            case PATTERN -> Sql.of("pattern_id = ?", List.of(Long.parseLong(p.value())));
            case INGESTED -> {
                long from = p.from() == null || p.from().isBlank() ? 0 : Long.parseLong(p.from());
                long to = p.to() == null || p.to().isBlank() ? Long.MAX_VALUE : Long.parseLong(p.to());
                yield Sql.of("ingested_ms BETWEEN ? AND ?", List.of(from, to));
            }
            case EXISTS -> Sql.of(filterCol(s, field(s, p), false) + " IS NOT NULL", List.of());
            case NOT_EXISTS -> Sql.of(filterCol(s, field(s, p), false) + " IS NULL", List.of());
            case CONTAINS -> {
                FieldDef f = field(s, p);
                String col = isLevelField(s, f) ? "level" : text(f);
                yield Sql.of(col + " LIKE ? ESCAPE '\\'", List.of(like(nn(p.value()))));
            }
            case EQ -> {
                FieldDef f = field(s, p);
                if (p.anyOf()) {
                    yield in(s, f, p.values(), false);
                }
                if (isLevelField(s, f)) {
                    yield Sql.of("level = ?", List.of(nn(LineBuilder.normalizeLevel(p.value()))));
                }
                Object typed = typedOrNull(f, p.value());
                yield typed != null ? Sql.of(typedCol(f) + " = ?", List.of(typed)) : Sql.of(text(f) + " = ?", List.of(nn(p.value())));
            }
            case NEQ -> {
                FieldDef f = field(s, p);
                if (p.anyOf()) {
                    yield in(s, f, p.values(), true);
                }
                if (isLevelField(s, f)) {
                    yield Sql.of("level IS NULL OR level <> ?", List.of(nn(LineBuilder.normalizeLevel(p.value()))));
                }
                Object typed = typedOrNull(f, p.value());
                yield typed != null
                        ? Sql.of(typedCol(f) + " IS NULL OR " + typedCol(f) + " <> ?", List.of(typed))
                        : Sql.of(text(f) + " IS NULL OR " + text(f) + " <> ?", List.of(nn(p.value())));
            }
            case GT, LT -> {
                FieldDef f = typedField(s, p);
                Object v = requireTyped(f, p.value());
                yield Sql.of(typedCol(f) + (p.op() == LogQuery.Op.GT ? " > ?" : " < ?"), List.of(v));
            }
            case BETWEEN -> {
                FieldDef f = typedField(s, p);
                yield Sql.of(typedCol(f) + " BETWEEN ? AND ?", List.of(requireTyped(f, p.from()), requireTyped(f, p.to())));
            }
        };
    }

    /**
     * Free text: the trigram index over the fields set to Text search (milliseconds); a term too
     * short for a trigram, or a source with no Text field, scans with LIKE and is flagged slow.
     */
    private static Sql text(String sourceId, LogStructure s, String value) {
        String v = nn(value);
        List<FieldDef> textFields = s.fields().stream().filter(f -> f.stored() && f.searchMode() == SearchMode.TEXT).toList();
        if (v.length() >= MIN_FTS_TERM && !textFields.isEmpty()) {
            return Sql.of("rid IN (SELECT rowid FROM " + SqliteLogsRepository.fts(sourceId) + " WHERE txt MATCH ?)",
                    List.of("\"" + v.replace("\"", "\"\"") + "\""));
        }
        List<FieldDef> scan = textFields.isEmpty()
                ? s.fields().stream().filter(f -> f.stored() && f.type() == FieldType.STRING).toList()
                : textFields;
        if (scan.isEmpty()) {
            return new Sql("0=1", List.of(), true);
        }
        String like = "%" + v.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%";
        List<Object> params = new ArrayList<>();
        String expr = scan.stream().map(f -> {
            params.add(like);
            return text(f) + " LIKE ? ESCAPE '\\'";
        }).collect(Collectors.joining(" OR "));
        return new Sql(expr, params, true);
    }

    /** "is any of" / "is none of": IN on the column EQ / NEQ use, each value converted the way EQ converts it. */
    private static Sql in(LogStructure s, FieldDef f, List<String> values, boolean negate) {
        List<Object> params = new ArrayList<>();
        String col;
        if (isLevelField(s, f)) {
            col = "level";
            values.forEach(v -> params.add(nn(LineBuilder.normalizeLevel(v))));
        } else {
            boolean allTyped = f.typed() && values.stream().allMatch(v -> typedOrNull(f, v) != null);
            col = allTyped ? typedCol(f) : text(f);
            values.forEach(v -> params.add(allTyped ? typedOrNull(f, v) : nn(v)));
        }
        String marks = values.stream().map(v -> "?").collect(Collectors.joining(","));
        return negate ? Sql.of(col + " IS NULL OR " + col + " NOT IN (" + marks + ")", params) : Sql.of(col + " IN (" + marks + ")", params);
    }

    private static String like(String v) {
        return "%" + v.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%";
    }

    /**
     * {@code structure:S2} / {@code structure!=S2}: the structure a line belongs to. A real field named
     * "structure" wins, so the pseudo-field never hides user data.
     */
    private static boolean isStructurePill(LogStructure s, LogQuery.Pill p) {
        return (p.op() == LogQuery.Op.EQ || p.op() == LogQuery.Op.NEQ) && LogQuery.STRUCTURE_FIELD.equals(p.field())
                && s.byLabel(LogQuery.STRUCTURE_FIELD).isEmpty();
    }

    private static int structureId(String value) {
        String v = value == null ? "" : value.strip();
        if (v.startsWith("S") || v.startsWith("s")) {
            v = v.substring(1);
        }
        try {
            return Integer.parseInt(v);
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("A structure is written S1, S2, ...");
        }
    }

    static FieldDef field(LogStructure s, LogQuery.Pill p) {
        FieldDef f = s.byLabel(p.field()).orElseThrow(() -> new IllegalArgumentException("Unknown field: " + p.field()));
        if (!f.stored()) {
            throw new IllegalArgumentException("Field " + p.field() + " repeats another field and is not searchable");
        }
        return f;
    }

    private static FieldDef typedField(LogStructure s, LogQuery.Pill p) {
        FieldDef f = field(s, p);
        if (!f.typed()) {
            throw new IllegalArgumentException(p.field() + " is text - set its type to number, date or datetime to compare it");
        }
        return f;
    }

    private static Object requireTyped(FieldDef f, String value) {
        Object v = typedOrNull(f, value);
        if (v == null) {
            throw new IllegalArgumentException("'" + value + "' is not a valid " + f.type().name().toLowerCase() + " for " + f.label());
        }
        return v;
    }

    private static Object typedOrNull(FieldDef f, String value) {
        return f.typed() ? ValueTyper.convert(value, f.type(), f.format()).orElse(null) : null;
    }

    private static String nn(String v) {
        return v == null ? "" : v;
    }
}
