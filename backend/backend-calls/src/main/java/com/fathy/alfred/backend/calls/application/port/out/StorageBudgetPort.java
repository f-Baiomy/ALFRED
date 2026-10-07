package com.fathy.alfred.backend.calls.application.port.out;

/** The outbound store's size cap, changeable while running (SQLite mode; specs/012-server-program, a LIVE setting). */
public interface StorageBudgetPort {

    void setMaxSizeBytes(long bytes);
}
