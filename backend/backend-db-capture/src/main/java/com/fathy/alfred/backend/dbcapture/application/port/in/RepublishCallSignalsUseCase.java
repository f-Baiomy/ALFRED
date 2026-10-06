package com.fathy.alfred.backend.dbcapture.application.port.in;

/**
 * Hands every stored call's log and database signals on once more - for a listener that started keeping them after
 * the calls were captured (triage, on the first start of specs/010-mcp-log-investigation). Bounded by what this slice
 * stores; read a page at a time.
 */
public interface RepublishCallSignalsUseCase {

    /** @return how many calls were handed on */
    int republishAll();
}
