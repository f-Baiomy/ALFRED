package com.fathy.alfred.backend.resend.application.port.out;

import com.fathy.alfred.backend.resend.domain.model.StoredCall;

import java.util.Optional;

public interface CallSourcePort {
    /** cycleId null means the live log. */
    Optional<StoredCall> load(String direction, String callId, String cycleId);
}
