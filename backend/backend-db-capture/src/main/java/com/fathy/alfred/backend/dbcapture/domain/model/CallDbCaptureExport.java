package com.fathy.alfred.backend.dbcapture.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

/** A call's whole database capture, as the .json export carries it under {@code dbCapture} (contracts/export-format.md). */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record CallDbCaptureExport(CallDbSummary summary, List<StatementTransaction> transactions, List<CallMarker> supplierMarkers,
                                  List<ExportedStatement> statements, List<ExportedStoreCommand> redis, CallStoreSummary redisSummary) {

    public CallDbCaptureExport(CallDbSummary summary, List<StatementTransaction> transactions, List<CallMarker> supplierMarkers,
                               List<ExportedStatement> statements) {
        this(summary, transactions, supplierMarkers, statements, null, null);
    }
}
