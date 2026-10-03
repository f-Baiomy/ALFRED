package com.fathy.alfred.backend.logs.domain.model;

/**
 * One way lines reach a source. {@code position} is the byte offset already ingested (saved in the
 * same transaction as each batch, so a restart resumes with no loss and no duplicates).
 *
 * @param fingerprint name + size + SHA-256 of the first MB, used to warn before loading the same
 *                    file into a source twice (clarification 2026-10-03)
 * @param statusReason why an input is PAUSED/FAILED/WAITING (e.g. LOW_DISK) - never line content
 */
public record LogInput(
        String id,
        String sourceId,
        InputKind kind,
        String path,
        String fileName,
        String fingerprint,
        InputStatus status,
        String statusReason,
        long position,
        long linesRead,
        long totalBytes,
        long mismatchCount,
        long unparsedCount,
        String startedAt,
        String updatedAt
) {

    public LogInput withStatus(InputStatus newStatus, String reason) {
        return new LogInput(id, sourceId, kind, path, fileName, fingerprint, newStatus, reason, position,
                linesRead, totalBytes, mismatchCount, unparsedCount, startedAt, updatedAt);
    }
}
