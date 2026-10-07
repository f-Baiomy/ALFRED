package com.fathy.alfred.backend.server.domain.model;

import java.time.Instant;

/** A saved RESTART setting that is not in effect yet: kept until the backend starts with {@code after}. */
public record PendingRestart(String key, String before, String after, Instant savedAt) {
}
