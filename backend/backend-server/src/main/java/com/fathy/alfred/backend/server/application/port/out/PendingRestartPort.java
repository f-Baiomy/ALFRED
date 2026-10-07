package com.fathy.alfred.backend.server.application.port.out;

import com.fathy.alfred.backend.server.domain.model.PendingRestart;

import java.util.List;

/** Saved RESTART settings not in effect yet (FR-025), kept across restarts of the page and the backend. */
public interface PendingRestartPort {

    List<PendingRestart> all();

    /** Replaces the whole list. */
    void replace(List<PendingRestart> pending);
}
