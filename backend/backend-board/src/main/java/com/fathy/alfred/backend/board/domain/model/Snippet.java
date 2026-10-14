package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;

/**
 * A page (specs/017 R29): a named HTML snippet (or diagram, or Python program) attached to a card, a cycle or a project,
 * shown as a tab and run in the locked frame. Every save is a new version (R32). {@code source} is null in lists.
 * {@code cardId}/{@code cycleId} say what it goes with: a card's pages go when the card goes, a cycle's when the cycle does.
 */
public record Snippet(String id, Owner ownerType, String ownerId, String project, String cardId, String cycleId, String name, Kind kind,
                      String info, String source, Actor author, boolean pinned, int position, int version, Instant createdAt,
                      Instant updatedAt, Actor updatedBy) {

    public enum Owner { CARD, CYCLE, PROJECT }

    /** BLOCK: a fixed block of the board (a ```chart fence...) pinned as a page - its source is that Markdown. */
    public enum Kind { HTML, MERMAID, PYTHON, BLOCK }

    /** R16: one snippet's source. */
    public static final int MAX_SOURCE_BYTES = 256 * 1024;
    public static final int MAX_NAME = 120;
    public static final int MAX_INFO = 500;
    public static final int MAX_PER_OWNER = 30;

    public Snippet withoutSource() {
        return new Snippet(id, ownerType, ownerId, project, cardId, cycleId, name, kind, info, null, author, pinned, position, version,
                createdAt, updatedAt, updatedBy);
    }
}
