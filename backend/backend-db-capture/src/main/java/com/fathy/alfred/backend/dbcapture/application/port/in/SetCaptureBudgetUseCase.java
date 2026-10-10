package com.fathy.alfred.backend.dbcapture.application.port.in;

/**
 * Changes the size kept for captured statements and Redis commands without a restart
 * (ALFRED_DB_CAPTURE_MAX_SIZE_BYTES, ALFRED_REDIS_CAPTURE_MAX_SIZE_BYTES - LIVE settings).
 */
public interface SetCaptureBudgetUseCase {

    void setStatementsMaxBytes(long bytes);

    void setRedisMaxBytes(long bytes);

    /**
     * One limit for everything captured with calls (statements, rows, log lines, Redis commands), from the storage
     * budget; 0 turns it off and the two caps above apply again. Past it the oldest calls lose their whole capture.
     */
    void setCombinedMaxBytes(long bytes);
}
