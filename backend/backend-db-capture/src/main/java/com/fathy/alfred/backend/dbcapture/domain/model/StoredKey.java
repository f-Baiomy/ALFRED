package com.fathy.alfred.backend.dbcapture.domain.model;

/** One key a stored command touched - the row of {@code store_keys} (data-model.md). */
public record StoredKey(String project, String key, String callId, int seq, String op, long atMs, String valueHash, Long ttlMs) {
}
