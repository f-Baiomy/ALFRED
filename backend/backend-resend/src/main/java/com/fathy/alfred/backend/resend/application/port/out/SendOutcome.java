package com.fathy.alfred.backend.resend.application.port.out;

/** What actually sending an {@link OutgoingCall} produced. */
public sealed interface SendOutcome {

    record Sent(int status, String body) implements SendOutcome {
    }

    /** Inbound, connection refused - the reverse-proxy listener for this project isn't running (see contracts/rest-api.md's 409). */
    record ReverseProxyNotRunning() implements SendOutcome {
    }

    record Failed(String message) implements SendOutcome {
    }
}
