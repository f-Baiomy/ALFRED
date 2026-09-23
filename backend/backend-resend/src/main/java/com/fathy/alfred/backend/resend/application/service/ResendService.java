package com.fathy.alfred.backend.resend.application.service;

import com.fathy.alfred.backend.resend.application.port.in.RecordResendUseCase;
import com.fathy.alfred.backend.resend.application.port.out.ResendLogPort;
import com.fathy.alfred.backend.resend.domain.model.ResendOutcome;
import org.springframework.stereotype.Service;
import java.time.Instant;
import java.util.UUID;

/**
 * Coordinates resend request/response lifecycle.
 * Records outcomes when a resend call completes.
 */
@Service
public class ResendService implements RecordResendUseCase {
    private final ResendLogPort resendLogPort;

    public ResendService(ResendLogPort resendLogPort) {
        this.resendLogPort = resendLogPort;
    }

    @Override
    public void recordResendOutcome(String resendRequestId, String originalCallId, String newCallId) {
        ResendOutcome outcome = new ResendOutcome(
                UUID.randomUUID().toString(),
                newCallId,
                resendRequestId,
                originalCallId,
                Instant.now().toString()
        );
        resendLogPort.saveOutcome(outcome);
    }
}
