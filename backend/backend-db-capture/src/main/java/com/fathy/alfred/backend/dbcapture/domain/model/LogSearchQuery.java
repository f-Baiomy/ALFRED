package com.fathy.alfred.backend.dbcapture.domain.model;

/**
 * A search over caught log lines (specs/010-mcp-log-investigation, contracts/investigate-api.md): a literal
 * {@code text} (message, logger, thread or exception, case-insensitive) or a regex {@code pattern}, narrowed by level
 * (at or above), logger, exception type and time. {@code outside} adds lines no call wrote. Paged newest first by line
 * id: {@code beforeId} is the cursor.
 */
public record LogSearchQuery(String text, String pattern, String minLevel, String logger, String exceptionType, Long fromMs, Long toMs,
                             boolean outside, Long beforeId, int limit) {

    public static final int MAX_LIMIT = 200;
    public static final int MAX_TEXT = 500;
    public static final int MAX_PATTERN = 200;

    public LogSearchQuery {
        limit = limit <= 0 ? 50 : Math.min(limit, MAX_LIMIT);
    }
}
