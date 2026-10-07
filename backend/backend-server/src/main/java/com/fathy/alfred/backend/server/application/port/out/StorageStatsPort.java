package com.fathy.alfred.backend.server.application.port.out;

/**
 * Sizes and traffic the storage checks compare against (FR-030/032). Implemented by backend-app/serverbridge over the
 * owning slices' existing size and count queries - this slice never depends on them directly.
 */
public interface StorageStatsPort {

    /** Bytes stored now for the size cap {@code key} (ALFRED_CALLS_MAX_SIZE_BYTES, ...), or -1 when unknown. */
    long usedBytes(String key);

    /** Inbound calls logged in the last hour (for the retention estimate), or -1 when unknown. */
    long inboundCallsLastHour();
}
