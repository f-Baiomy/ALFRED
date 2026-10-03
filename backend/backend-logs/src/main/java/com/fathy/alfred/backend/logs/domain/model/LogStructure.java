package com.fathy.alfred.backend.logs.domain.model;

import java.util.Comparator;
import java.util.List;
import java.util.Optional;

/**
 * A source's structure and every user setting attached to it (FR-010..016, FR-043/044).
 *
 * <p>Lines of one source may each have their own structure (FR-045 as amended): the field list is
 * every field any line has had, the way an OpenSearch index mapping is; a line simply has no value
 * for the fields it lacks. Which lines share a structure is tracked separately ({@link LineShape}).
 *
 * @param id             hash of the sorted field-path set: two inputs with the same id have the same
 *                       structure, which is how a new input is offered an existing source's settings (FR-048)
 * @param overflowPaths  fields seen after the source reached {@link #MAX_STORED_FIELDS} (the first
 *                       {@link #MAX_OVERFLOW_LISTED}): not stored as columns, so not searchable; still in
 *                       the raw line and the JSON view
 * @param defaultFieldLayout how a line's Table view starts (each line can switch); null = GROUPED
 * @param payloadPaths   parts of a line kept as ONE text field (their JSON) instead of a field per leaf:
 *                       request/response bodies and other big or id-keyed parts (payload option A,
 *                       {@code PayloadRule})
 */
public record LogStructure(
        String id,
        List<FieldDef> fields,
        List<GroupLevel> groupLevels,
        String template,
        List<String> columns,
        DataView defaultDataView,
        String timeZone,
        List<String> overflowPaths,
        List<String> payloadPaths,
        FieldLayout defaultFieldLayout
) {

    /** Searchable fields per source: two columns each stay well under SQLite's 2,000-column limit. */
    public static final int MAX_STORED_FIELDS = 900;
    /** All fields, including JSON-in-text duplicates that only live in the raw line. */
    public static final int MAX_FIELDS = 2_000;
    public static final int MAX_OVERFLOW_LISTED = 1_000;

    public LogStructure {
        overflowPaths = overflowPaths == null ? List.of() : List.copyOf(overflowPaths);
        payloadPaths = payloadPaths == null ? List.of() : List.copyOf(payloadPaths);
        defaultFieldLayout = defaultFieldLayout == null ? FieldLayout.GROUPED : defaultFieldLayout;
    }

    public LogStructure(String id, List<FieldDef> fields, List<GroupLevel> groupLevels, String template, List<String> columns,
                        DataView defaultDataView, String timeZone, List<String> overflowPaths, List<String> payloadPaths) {
        this(id, fields, groupLevels, template, columns, defaultDataView, timeZone, overflowPaths, payloadPaths, FieldLayout.GROUPED);
    }

    public LogStructure(String id, List<FieldDef> fields, List<GroupLevel> groupLevels, String template, List<String> columns,
                        DataView defaultDataView, String timeZone, List<String> overflowPaths) {
        this(id, fields, groupLevels, template, columns, defaultDataView, timeZone, overflowPaths, List.of());
    }

    public LogStructure(String id, List<FieldDef> fields, List<GroupLevel> groupLevels, String template, List<String> columns,
                        DataView defaultDataView, String timeZone) {
        this(id, fields, groupLevels, template, columns, defaultDataView, timeZone, List.of(), List.of());
    }

    public Optional<FieldDef> byLabel(String label) {
        return fields.stream().filter(f -> f.label().equals(label)).findFirst();
    }

    public Optional<FieldDef> byPath(String path) {
        return fields.stream().filter(f -> f.path().equals(path)).findFirst();
    }

    /** The first field of a role (see {@link #rolesOf}). */
    public Optional<FieldDef> byRole(Role role) {
        return rolesOf(role).stream().findFirst();
    }

    /** Every stored field with this role, in the order a line tries them (rank, then field order). */
    public List<FieldDef> rolesOf(Role role) {
        return fields.stream().filter(f -> f.role() == role && f.stored())
                .sorted(Comparator.comparingInt((FieldDef f) -> f.roleRank() <= 0 ? Integer.MAX_VALUE : f.roleRank())
                        .thenComparingInt(FieldDef::index))
                .toList();
    }

    public long storedCount() {
        return fields.stream().filter(FieldDef::stored).count();
    }

    public int nextIndex() {
        return fields.stream().mapToInt(FieldDef::index).max().orElse(-1) + 1;
    }

    public LogStructure withFields(List<FieldDef> newFields) {
        return new LogStructure(id, newFields, groupLevels, template, columns, defaultDataView, timeZone, overflowPaths, payloadPaths,
                defaultFieldLayout);
    }

    public LogStructure withPayloads(List<String> newPayloads) {
        return new LogStructure(id, fields, groupLevels, template, columns, defaultDataView, timeZone, overflowPaths, newPayloads,
                defaultFieldLayout);
    }

    public LogStructure withOverflow(List<String> newOverflow) {
        return new LogStructure(id, fields, groupLevels, template, columns, defaultDataView, timeZone, newOverflow, payloadPaths,
                defaultFieldLayout);
    }
}
