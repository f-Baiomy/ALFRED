package com.fathy.alfred.backend.logs.domain.model;

/**
 * One way lines reach a source. {@code position} is the byte offset already ingested (saved in the
 * same transaction as each batch, so a restart resumes with no loss and no duplicates).
 *
 * @param fingerprint name + size + SHA-256 of the first MB, used to warn before loading the same
 *                    file into a source twice (clarification 2026-10-03)
 * @param statusReason why an input is PAUSED/FAILED/WAITING (e.g. LOW_DISK) - never line content
 * @param parentId     a WATCHED_FILE's folder input (WATCH); null otherwise
 * @param options      a WATCH input's {@link WatchOptions} as JSON; null otherwise
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
        String updatedAt,
        String parentId,
        String options
) {

    public LogInput(String id, String sourceId, InputKind kind, String path, String fileName, String fingerprint, InputStatus status,
                    String statusReason, long position, long linesRead, long totalBytes, long mismatchCount, long unparsedCount,
                    String startedAt, String updatedAt) {
        this(id, sourceId, kind, path, fileName, fingerprint, status, statusReason, position, linesRead, totalBytes, mismatchCount,
                unparsedCount, startedAt, updatedAt, null, null);
    }

    public LogInput withStatus(InputStatus newStatus, String reason) {
        return new LogInput(id, sourceId, kind, path, fileName, fingerprint, newStatus, reason, position,
                linesRead, totalBytes, mismatchCount, unparsedCount, startedAt, updatedAt, parentId, options);
    }

    /** Followed live: a single followed file, or a live (not archive) file of a watched folder. */
    public boolean followed() {
        return kind == InputKind.FOLLOW || (kind == InputKind.WATCHED_FILE && !"archive".equals(options));
    }
}
