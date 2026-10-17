package com.fathy.alfred.backend.teamboards.spi;

/**
 * A provider call failed. The message never contains the token or a response body (contracts/connector-spi.md).
 * {@code retryAfterSeconds} is set for BUSY.
 */
public final class ProviderException extends Exception {

    public enum Kind { TOKEN_REJECTED, NOT_FOUND, BUSY, UNREACHABLE, BAD_RESPONSE }

    private final Kind kind;
    private final Integer retryAfterSeconds;

    public ProviderException(Kind kind, String message) {
        this(kind, message, null);
    }

    public ProviderException(Kind kind, String message, Integer retryAfterSeconds) {
        super(message);
        this.kind = kind;
        this.retryAfterSeconds = retryAfterSeconds;
    }

    public Kind kind() {
        return kind;
    }

    public Integer retryAfterSeconds() {
        return retryAfterSeconds;
    }
}
