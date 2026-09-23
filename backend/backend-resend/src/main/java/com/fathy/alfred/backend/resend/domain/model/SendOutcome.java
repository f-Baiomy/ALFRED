package com.fathy.alfred.backend.resend.domain.model;

public sealed interface SendOutcome {
    record Sent(int status, long durationMs) implements SendOutcome {
    }

    record ReverseProxyNotRunning() implements SendOutcome {
    }

    record Failed(String message) implements SendOutcome {
    }
}
