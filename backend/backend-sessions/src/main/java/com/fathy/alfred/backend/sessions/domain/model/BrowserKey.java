package com.fathy.alfred.backend.sessions.domain.model;

import java.time.Instant;

/** A browser paired with a user's helper by a one-time code: it writes as that user. */
public record BrowserKey(String keyId, String helperKeyId, String user, String label, Instant pairedAt, Instant lastSeen, Instant revokedAt) {
}
