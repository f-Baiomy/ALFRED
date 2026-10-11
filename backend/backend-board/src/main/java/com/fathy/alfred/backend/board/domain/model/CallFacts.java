package com.fathy.alfred.backend.board.domain.model;

import java.util.Map;

/**
 * What a re-test reads about one call (specs/016): its status and duration, its statements per table (null when ◆
 * database capture did not record the call), its ERROR / WARN log line counts (null when ▤ lines were not caught), and
 * the response values at the JSON paths asked for (a missing path has no entry).
 */
public record CallFacts(Integer status, Double durationMs, Integer statements, Map<String, Integer> statementsByTable,
                        Integer errors, Integer warnings, Map<String, String> values) {

    public CallFacts {
        statementsByTable = statementsByTable == null ? null : Map.copyOf(statementsByTable);
        values = values == null ? Map.of() : Map.copyOf(values);
    }

    /** Statements on {@code table} (case-insensitive), or every statement when the table is null; null when not captured. */
    public Integer statementsOn(String table) {
        if (statementsByTable == null) {
            return null;
        }
        if (table == null) {
            return statements != null ? statements : statementsByTable.values().stream().mapToInt(Integer::intValue).sum();
        }
        return statementsByTable.entrySet().stream().filter(e -> e.getKey().equalsIgnoreCase(table)).mapToInt(Map.Entry::getValue).sum();
    }
}
