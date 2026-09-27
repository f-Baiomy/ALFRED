package com.fathy.alfred.backend.resend.application.port.out;

import java.util.Map;

/** What actually sending an {@link OutgoingCall} produced. */
public sealed interface SendOutcome {

    /**
     * @param headers lower-case header names, repeated headers already joined with {@code ", "}
     *                (contracts.md section 2) - the supplier response passed back so a resend's
     *                caller (chaining, assertions) needs no second fetch.
     * @param body    text, UTF-8 lossy for binary, already capped at
     *                {@code alfred.interception.max-answer-bytes}.
     */
    record Sent(int status, Map<String, String> headers, String body) implements SendOutcome {
        public Sent {
            headers = headers == null ? Map.of() : Map.copyOf(headers);
        }
    }

    /** Inbound, connection refused - the reverse-proxy listener for this project isn't running (see contracts/rest-api.md's 409). */
    record ReverseProxyNotRunning() implements SendOutcome {
    }

    record Failed(String message) implements SendOutcome {
    }
}
