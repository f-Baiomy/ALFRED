package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;

/**
 * A "tell me when" Claude set from a chat (specs/022 FR-031, research R13): Alfred checks it as calls are captured - no
 * model, no timer - posts in the chat when it fires, then forgets it. Removed when it fired, was cancelled, or its cycle
 * stopped recording or was removed.
 *
 * @param target the acceptance item key (ITEM_PASSES), a status class such as "5xx" or "404" (STATUS), or an endpoint (ERROR_LOG)
 */
public record ChatWatch(long id, ChatKey chat, Kind kind, String target, String label, Long messageId, Instant createdAt) {

    public enum Kind { ITEM_PASSES, STATUS, ERROR_LOG }
}
