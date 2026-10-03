package com.fathy.alfred.backend.logs.domain.model;

/**
 * A named collection of log lines sharing one structure, fed by any number of inputs.
 * Counts and sizes are maintained per ingest batch, never computed per request.
 *
 * @param retentionMaxBytes 0 = keep every line (the default: what you load stays); otherwise the oldest
 *                          unpinned lines go once the source grows past it. There is no age-based retention.
 */
public record LogSource(
        String id,
        String name,
        RawMode rawMode,
        PrivacyMode privacyMode,
        long retentionMaxBytes,
        long lineCount,
        long storedBytes,
        long unparsedCount,
        String createdAt,
        String updatedAt
) {
}
