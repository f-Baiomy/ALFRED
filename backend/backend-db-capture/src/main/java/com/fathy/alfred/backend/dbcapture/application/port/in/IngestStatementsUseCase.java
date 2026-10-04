package com.fathy.alfred.backend.dbcapture.application.port.in;

import com.fathy.alfred.backend.dbcapture.domain.model.IngestBatch;
import com.fathy.alfred.backend.dbcapture.domain.model.IngestResult;

/** Stores one agent batch (or a re-imported export) - idempotent per statement. */
public interface IngestStatementsUseCase {
    IngestResult ingest(IngestBatch batch);
}
