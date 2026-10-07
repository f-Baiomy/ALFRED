package com.fathy.alfred.backend.calls.application.port.in;

/** Changes the total size kept for outbound calls, without a restart (ALFRED_CALLS_MAX_SIZE_BYTES, a LIVE setting). */
public interface SetStorageBudgetUseCase {

    /** @throws IllegalStateException when the store has no size cap (file mode caps rows instead) */
    void setMaxSizeBytes(long bytes);
}
