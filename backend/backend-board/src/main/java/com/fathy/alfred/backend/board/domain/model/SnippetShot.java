package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;

/**
 * What a snippet looked like (specs/017 R28, R31): a PNG the frame drew of itself after rendering a version, and its
 * console (the last lines it logged, errors included) - so Claude can see what it drew without a browser. A page's
 * {@code version} is its version; an inline block's is a hash of its source (it has no versions). The newest is by time.
 */
public record SnippetShot(String snippetId, int version, byte[] png, String console, Instant at) {

    public static final int MAX_PNG_BYTES = 5 * 1024 * 1024;
    public static final int MAX_CONSOLE = 64 * 1024;
    /** Shots kept per snippet: the newest versions'. */
    public static final int KEEP = 5;
}
