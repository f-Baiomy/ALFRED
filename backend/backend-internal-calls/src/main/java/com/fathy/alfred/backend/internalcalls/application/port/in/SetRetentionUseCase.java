package com.fathy.alfred.backend.internalcalls.application.port.in;

/** Changes how many inbound calls are kept, without a restart (INTERNAL_CALLS_RETENTION_ROWS, a LIVE setting). */
public interface SetRetentionUseCase {

    void setRetentionRows(int rows);

    /** Changes the total size kept for inbound calls, without a restart. */
    void setMaxSizeBytes(long bytes);
}
