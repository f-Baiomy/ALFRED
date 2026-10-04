package com.fathy.alfred.backend.dbcapture.domain.model;

import java.util.List;

/** A page of a statement's stored rows. {@code total} is rows STORED; {@code rowsRead} is what the application read,
 *  larger when the per-result limit was hit ({@code overLimit}). */
public record RowsPage(List<Column> columns, List<List<TypedValue>> rows, long total, Long rowsRead, Boolean partial, Boolean overLimit) {
}
