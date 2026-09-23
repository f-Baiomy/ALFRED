package com.fathy.alfred.backend.resend.application.port.in;

import com.fathy.alfred.backend.resend.domain.model.ResendRequest;
import com.fathy.alfred.backend.resend.domain.model.ResendResult;

public interface ResendCallUseCase {
    ResendOutcome resend(ResendRequest request);

    sealed interface ResendOutcome {
        record Done(ResendResult result) implements ResendOutcome {
        }

        record NotFound() implements ResendOutcome {
        }

        record ReverseProxyNotRunning() implements ResendOutcome {
        }

        record SendFailed(String message) implements ResendOutcome {
        }
    }
}
