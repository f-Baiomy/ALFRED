package com.fathy.alfred.backend.dbcapture.domain.model;

import java.util.List;

/** The database window's statement list for one call, after a sequence number, with its transactions and where its
 *  supplier calls sit. */
public record CallStatementsPage(List<CapturedStatement> statements, List<StatementTransaction> transactions,
                                 List<CallMarker> supplierMarkers, boolean hasMore) {
}
