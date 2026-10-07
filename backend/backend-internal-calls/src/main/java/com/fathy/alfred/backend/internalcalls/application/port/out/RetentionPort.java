package com.fathy.alfred.backend.internalcalls.application.port.out;

/** The inbound store's row cap, changeable while running (specs/012-server-program, a LIVE setting). */
public interface RetentionPort {

    void setRetentionRows(int rows);
}
