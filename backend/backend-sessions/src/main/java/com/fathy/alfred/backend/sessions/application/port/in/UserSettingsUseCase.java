package com.fathy.alfred.backend.sessions.application.port.in;

import com.fathy.alfred.backend.sessions.domain.model.Caller;

/**
 * My settings (specs/031): one JSON object per user - folders per PC, where sessions open, models per job, budget, away
 * rule, notifications. Read and written only by that user's own keys; there is no way to list or read another user's.
 * Never holds a secret: the Azure token stays on the user's PC (the helper keeps it).
 */
public interface UserSettingsUseCase {

    int MAX_BYTES = 64 * 1024;

    String get(Caller caller);

    /** Replaces the caller's settings; refused (empty) when not a JSON object or larger than {@link #MAX_BYTES}. */
    java.util.Optional<String> put(Caller caller, String json);
}
