package com.fathy.alfred.backend.dbcapture.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * "Written by" for a read that hit (specs/011-redis-capture FR-025): the last recorded write of the same key before it
 * - its call (method, path, status when known), how long before, and whether the value read equals the value written.
 * {@code none}: why there is no writer to show.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record KeyWriter(String callId, Integer seq, String command, String method, String path, Integer status, Long agoMillis,
                        Boolean sameValue, String none) {

    public static KeyWriter none(String reason) {
        return new KeyWriter(null, null, null, null, null, null, null, null, reason);
    }
}
