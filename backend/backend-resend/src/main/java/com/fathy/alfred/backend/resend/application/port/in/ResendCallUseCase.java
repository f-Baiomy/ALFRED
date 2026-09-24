package com.fathy.alfred.backend.resend.application.port.in;

import com.fathy.alfred.backend.resend.domain.model.ResendRequest;
import com.fathy.alfred.backend.resend.domain.model.ResendResult;

/** Resends a logged call through Alfred's own proxies. See contracts/rest-api.md's {@code POST /resend}. */
public interface ResendCallUseCase {

    ResendOutcome resend(ResendRequest request);

    sealed interface ResendOutcome {
        record Success(ResendResult result) implements ResendOutcome {
        }

        record NotFound() implements ResendOutcome {
        }

        record ReverseProxyNotRunning() implements ResendOutcome {
        }

        record SendFailed(String message) implements ResendOutcome {
        }
    }
}
