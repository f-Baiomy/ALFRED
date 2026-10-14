package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;

/**
 * One value a snippet saved with {@code alfred.state.set} (specs/017 R23): JSON text, shared by everyone who opens it.
 * Inline snippets (an {@code html live} block inside a text) have no row of their own; their id says where they are -
 * {@code inline:card:<cardId>:<desc|entryId>:<n>} or {@code inline:cycle:<cycleId>:brief:<n>}.
 */
public record SnippetState(String snippetId, String key, String value, Actor updatedBy, Instant at) {

    public static final int MAX_KEY = 100;
    public static final int MAX_VALUE_BYTES = 64 * 1024;
    public static final int MAX_KEYS = 200;
    /** Earlier values kept per key. */
    public static final int HISTORY = 50;
}
