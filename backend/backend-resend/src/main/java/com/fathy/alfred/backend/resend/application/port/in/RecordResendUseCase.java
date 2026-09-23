package com.fathy.alfred.backend.resend.application.port.in;

import com.fathy.alfred.backend.resend.domain.model.ResendOutcome;

/**
 * Use case: record the outcome of a resend operation.
 * Called by the backend-calls webhook complete flow when a resend call finishes.
 */
public interface RecordResendUseCase {
    void recordResendOutcome(String resendRequestId, String originalCallId, String newCallId);
}
