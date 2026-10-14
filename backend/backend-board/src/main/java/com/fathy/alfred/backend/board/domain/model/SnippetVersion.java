package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;

/** One saved version of a page (specs/017 R32). {@code source} is null in the version list. */
public record SnippetVersion(String snippetId, int version, String name, String info, String source, int size, Actor author, Instant at) {
}
