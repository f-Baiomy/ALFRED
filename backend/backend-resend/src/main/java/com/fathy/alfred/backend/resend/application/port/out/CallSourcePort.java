package com.fathy.alfred.backend.resend.application.port.out;

import com.fathy.alfred.backend.resend.domain.model.StoredCall;

import java.util.Optional;

/**
 * Reads a logged call's request side - implemented by backend-app's resendbridge against the
 * calls, internal-calls and session-cycles detail use cases. This slice never depends on those
 * slices directly (CLAUDE.md: hexagonal-per-vertical-slice).
 */
public interface CallSourcePort {

    Optional<StoredCall> load(String direction, String callId, String cycleId);
}
