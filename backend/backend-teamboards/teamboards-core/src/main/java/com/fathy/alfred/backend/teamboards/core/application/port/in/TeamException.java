package com.fathy.alfred.backend.teamboards.core.application.port.in;

import com.fathy.alfred.backend.teamboards.spi.ProviderException;

/**
 * A refused Team request (specs/028 contracts/teamboards-rest.md): the code and HTTP status the web layer answers with,
 * and a message for the user. Never carries a token or a provider's response body.
 */
public class TeamException extends RuntimeException {

    public enum Code {
        TOKEN_MISSING(401), TOKEN_REJECTED(403), PROVIDER_BUSY(429), UNREACHABLE(502), BAD_RESPONSE(400), NOT_FOUND(404), NOT_SUPPORTED(404),
        INVALID(400), USER_ONLY(403), CONFLICT(409), TOO_MANY(429), ASK(409);

        private final int status;

        Code(int status) {
            this.status = status;
        }

        public int status() {
            return status;
        }
    }

    private final Code code;
    private final Integer retryAfter;

    public TeamException(Code code, String message) {
        this(code, message, null);
    }

    public TeamException(Code code, String message, Integer retryAfter) {
        super(message);
        this.code = code;
        this.retryAfter = retryAfter;
    }

    public Code code() {
        return code;
    }

    public Integer retryAfter() {
        return retryAfter;
    }

    public static TeamException notFound(String message) {
        return new TeamException(Code.NOT_FOUND, message);
    }

    public static TeamException invalid(String message) {
        return new TeamException(Code.INVALID, message);
    }

    public static TeamException userOnly(String message) {
        return new TeamException(Code.USER_ONLY, message);
    }

    /** A provider failure in the user's words; the message already names the call and the provider's reason. */
    public static TeamException of(ProviderException e) {
        return switch (e.kind()) {
            case TOKEN_REJECTED -> new TeamException(Code.TOKEN_REJECTED, "The tracker refused the token - it may have expired or lack the scope: "
                    + e.getMessage());
            case NOT_FOUND -> new TeamException(Code.NOT_FOUND, e.getMessage());
            case BUSY -> new TeamException(Code.PROVIDER_BUSY, e.getMessage(), e.retryAfterSeconds() == null ? 30 : e.retryAfterSeconds());
            case UNREACHABLE -> new TeamException(Code.UNREACHABLE, e.getMessage());
            case BAD_RESPONSE -> new TeamException(Code.BAD_RESPONSE, e.getMessage());
        };
    }
}
