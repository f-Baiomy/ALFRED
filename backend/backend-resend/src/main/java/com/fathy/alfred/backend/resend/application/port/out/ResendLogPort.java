package com.fathy.alfred.backend.resend.application.port.out;

import com.fathy.alfred.backend.resend.domain.model.ResendRequest;
import com.fathy.alfred.backend.resend.domain.model.ResendOutcome;
import java.util.Optional;

/**
 * Persistence port for resend requests and their outcomes.
 * Implementations decide storage format (file, SQLite, etc.) independently.
 */
public interface ResendLogPort {
    void saveRequest(ResendRequest request);

    void saveOutcome(ResendOutcome outcome);

    Optional<ResendRequest> findRequest(String id);

    Optional<ResendOutcome> findOutcomeByNewCallId(String newCallId);
}
