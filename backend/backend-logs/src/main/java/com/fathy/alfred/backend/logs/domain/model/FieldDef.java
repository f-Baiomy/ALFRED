package com.fathy.alfred.backend.logs.domain.model;

/**
 * One field of a log structure: a flattened path such as {@code message.context.timeTaken}.
 *
 * <p>{@code index} is the storage column number ({@code f<index>} keeps the original text,
 * {@code t<index>} the typed value) and is never reused, so changing a field's type or search
 * mode never moves its data. {@code label} is what the user types in pills and templates; it is
 * the path without wrapper prefixes and is unique within the structure.
 *
 * @param duplicateOf set when this field was unpacked from JSON stored in a text value and its
 *                    leaves equal another subtree (the OpenSearch {@code _source.body} case); such
 *                    fields are not stored as columns - the raw line still has them
 * @param roleRank    order among the fields sharing one role (1 = tried first): lines of different
 *                    structures can carry the same meaning under different names, and each line
 *                    uses the first of them it has; 0 = not ranked (field order decides)
 */
public record FieldDef(
        int index,
        String path,
        String label,
        FieldType type,
        TypeSource typeSource,
        String format,
        double matchRate,
        long invalidCount,
        boolean suggestBoolean,
        SearchMode searchMode,
        Role role,
        boolean sensitive,
        String duplicateOf,
        long firstSeenLine,
        String sample,
        int roleRank
) {

    /** A field without a role rank (detection, new fields); ranks are normalised when a structure is saved. */
    public FieldDef(int index, String path, String label, FieldType type, TypeSource typeSource, String format, double matchRate,
                    long invalidCount, boolean suggestBoolean, SearchMode searchMode, Role role, boolean sensitive,
                    String duplicateOf, long firstSeenLine, String sample) {
        this(index, path, label, type, typeSource, format, matchRate, invalidCount, suggestBoolean, searchMode, role, sensitive,
                duplicateOf, firstSeenLine, sample, 0);
    }

    public boolean typed() {
        return type != FieldType.STRING;
    }

    public boolean stored() {
        return duplicateOf == null;
    }

    public FieldDef withType(FieldType newType, String newFormat, TypeSource source) {
        return new FieldDef(index, path, label, newType, source, newFormat, matchRate, invalidCount,
                suggestBoolean, searchMode, role, sensitive, duplicateOf, firstSeenLine, sample, roleRank);
    }

    public FieldDef withMatch(double newMatchRate, long newInvalidCount) {
        return new FieldDef(index, path, label, type, typeSource, format, newMatchRate, newInvalidCount,
                suggestBoolean, searchMode, role, sensitive, duplicateOf, firstSeenLine, sample, roleRank);
    }

    public FieldDef withLabel(String newLabel) {
        return new FieldDef(index, path, newLabel, type, typeSource, format, matchRate, invalidCount,
                suggestBoolean, searchMode, role, sensitive, duplicateOf, firstSeenLine, sample, roleRank);
    }

    public FieldDef withIndex(int newIndex) {
        return new FieldDef(newIndex, path, label, type, typeSource, format, matchRate, invalidCount,
                suggestBoolean, searchMode, role, sensitive, duplicateOf, firstSeenLine, sample, roleRank);
    }

    public FieldDef withRole(Role newRole, int newRank) {
        return new FieldDef(index, path, label, type, typeSource, format, matchRate, invalidCount,
                suggestBoolean, searchMode, newRole, sensitive, duplicateOf, firstSeenLine, sample, newRank);
    }

    public FieldDef withSearchMode(SearchMode newMode) {
        return new FieldDef(index, path, label, type, typeSource, format, matchRate, invalidCount,
                suggestBoolean, newMode, role, sensitive, duplicateOf, firstSeenLine, sample, roleRank);
    }
}
