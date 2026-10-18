package com.fathy.alfred.backend.sessions.domain.model;

/** A new key, given out once: {@code key} is the whole secret the caller sends as {@code X-Alfred-Key}; Alfred keeps only its hash. */
public record Issued(String keyId, String key, String user, String machine) {
}
