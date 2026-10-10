package com.fathy.alfred.backend.calls.application.port.out;

/** The outbound store's size cap, changeable while running (SQLite mode; specs/012-server-program, a LIVE setting). */
public interface StorageBudgetPort {

    void setMaxSizeBytes(long bytes);

    /** The most calls kept, 0 for no count limit (the storage page's "and at most N calls"). */
    /** Trims to the limits now rather than at the next periodic check. */
    default void trimNow() {
    }

    default void setMaxRows(int rows) {
        throw new UnsupportedOperationException("this store has no row limit");
    }
}
