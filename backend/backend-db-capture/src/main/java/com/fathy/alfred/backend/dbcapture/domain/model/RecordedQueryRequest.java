package com.fathy.alfred.backend.dbcapture.domain.model;

/**
 * A query over RECORDED data (a statement's stored rows, or a call's statements) - never the application's database.
 * {@code mode} search: {@code text} matches any column; sql: {@code text} is one SELECT over the table
 * {@code result} (rows) or {@code statements}.
 */
public record RecordedQueryRequest(String mode, String text, String sortColumn, String sortDir, int offset, int limit) {
    public boolean isSql() {
        return "sql".equalsIgnoreCase(mode);
    }
}
