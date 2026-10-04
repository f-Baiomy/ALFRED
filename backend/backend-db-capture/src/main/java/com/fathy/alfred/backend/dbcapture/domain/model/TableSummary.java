package com.fathy.alfred.backend.dbcapture.domain.model;

/** The Tables view: what one call read and changed in one table. */
public record TableSummary(String table, int reads, int inserts, int updates, long deletedRows, int failed, long rowsRead, long micros) {
}
