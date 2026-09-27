package com.fathy.alfred.backend.resend.application.port.in;

/** A resolved method/url/header/body exceeded the resolution size guard - see {@code ResendService.resolveVariables}. */
public class ResendResolutionException extends RuntimeException {
    public ResendResolutionException(String message) {
        super(message);
    }
}
