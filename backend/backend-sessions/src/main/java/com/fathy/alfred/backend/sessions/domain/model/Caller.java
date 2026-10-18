package com.fathy.alfred.backend.sessions.domain.model;

/**
 * Who sent a request, read from its {@code X-Alfred-Key}: a user's helper (one per PC) or a browser paired to it. A user is
 * named by the email the helper registered with, lower-cased. {@code helperKeyId} is the helper itself, or the helper the
 * browser was paired with.
 */
public record Caller(String user, String machine, String keyId, String helperKeyId, Kind kind) {

    public enum Kind { HELPER, BROWSER }

    public boolean isHelper() {
        return kind == Kind.HELPER;
    }
}
