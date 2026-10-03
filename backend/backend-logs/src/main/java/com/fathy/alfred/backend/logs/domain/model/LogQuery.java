package com.fathy.alfred.backend.logs.domain.model;

import java.util.List;

/**
 * The one storage-neutral query the explorer sends (contracts/log-query.md). Adapters translate it
 * (SQL now; a document database or OpenSearch later) - nothing above the adapter sees storage syntax.
 *
 * @param cursor opaque keyset cursor from the previous page, or null for the first page
 */
public record LogQuery(List<Pill> pills, Long from, Long to, Sort sort, String cursor, int limit) {

    public static final int MAX_PILLS = 50;
    public static final int MAX_SELECTION = 10_000;
    public static final int MAX_LIMIT = 500;
    public static final int DEFAULT_LIMIT = 200;
    /** Pseudo-field for EQ/NEQ pills on the structure a line belongs to ({@code structure:S2}). */
    public static final String STRUCTURE_FIELD = "structure";

    /** PATTERN (value = pattern id) lists one pattern's lines in the Patterns view. */
    public enum Op { EQ, NEQ, GT, LT, BETWEEN, EXISTS, NOT_EXISTS, TEXT, SELECTION, PATTERN }

    /** {@code field} is a label; {@code value}/{@code from}/{@code to} are compared using the field's type. */
    public record Pill(Op op, String field, String value, String from, String to, List<String> lineIds) {
    }

    /** Sort by a field label (null = time) and direction. */
    public record Sort(String field, boolean ascending) {
    }

    /** Server-side clamps (constitution I: no caller can request unbounded work). */
    public LogQuery normalized() {
        List<Pill> p = pills == null ? List.of() : pills;
        if (p.size() > MAX_PILLS) {
            throw new IllegalArgumentException("At most " + MAX_PILLS + " filters");
        }
        for (Pill pill : p) {
            if (pill.op() == null) {
                throw new IllegalArgumentException("Filter without an operator");
            }
            if (pill.op() == Op.SELECTION && (pill.lineIds() == null || pill.lineIds().size() > MAX_SELECTION)) {
                throw new IllegalArgumentException("A selection filter holds 1-" + MAX_SELECTION + " lines");
            }
            if (pill.op() != Op.TEXT && pill.op() != Op.SELECTION && pill.op() != Op.PATTERN && (pill.field() == null || pill.field().isBlank())) {
                throw new IllegalArgumentException("Filter " + pill.op() + " needs a field");
            }
        }
        int l = limit <= 0 ? DEFAULT_LIMIT : Math.min(limit, MAX_LIMIT);
        return new LogQuery(p, from, to, sort == null ? new Sort(null, false) : sort, cursor, l);
    }

    public LogQuery withLimit(int newLimit) {
        return new LogQuery(pills, from, to, sort, cursor, newLimit);
    }

    public LogQuery withCursor(String newCursor) {
        return new LogQuery(pills, from, to, sort, newCursor, limit);
    }

    public boolean hasFilters() {
        return (pills != null && !pills.isEmpty()) || from != null || to != null;
    }
}
