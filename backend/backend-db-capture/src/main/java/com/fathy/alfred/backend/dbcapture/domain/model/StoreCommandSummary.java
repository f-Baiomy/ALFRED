package com.fathy.alfred.backend.dbcapture.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

/**
 * One row of a call's store commands for the Redis view - everything but the bytes (specs/011-redis-capture
 * data-model.md). {@code rw}: r / w / o; {@code outcome}: HIT / MISS / OK / FAILED; {@code replyPreview} is at most 200
 * characters of the reply as text (masked keys: {@code ‹masked · n B›}) - only ever a list row, never exported.
 * {@code argsText}: the arguments after the command name and keys, for the row (each cut to 80 characters).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record StoreCommandSummary(
        long id,
        String store,
        int seq,
        String at,
        long micros,
        String command,
        List<String> keys,
        int keysTotal,
        String keyPattern,
        String rw,
        String outcome,
        String replyType,
        String replyPreview,
        String argsText,
        String error,
        StoreOrigin origin,
        StoreGroup group,
        String code,
        String client,
        String connection,
        Long poolWaitMicros,
        long bytes,
        long replyBytes,
        boolean hasBefore,
        String beforeNote,
        String runTag
) {
}
