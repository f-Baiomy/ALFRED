package com.fathy.alfred.backend.board.domain.model;

import java.util.Set;

/** A board list request; every limit is clamped here so no caller can ask for unbounded work. */
public record CardQuery(String project, String cycleId, Set<CardKind> kinds, Set<CardStatus> statuses, Set<Flag> flags,
                        Actor author, boolean scopeNotDecided, String q, int offset, int limit) {

    public static final int MAX_LIMIT = 500;
    public static final int DEFAULT_LIMIT = 200;

    public CardQuery {
        kinds = kinds == null ? Set.of() : Set.copyOf(kinds);
        statuses = statuses == null ? Set.of() : Set.copyOf(statuses);
        flags = flags == null ? Set.of() : Set.copyOf(flags);
        q = q == null || q.isBlank() ? null : q.strip();
        offset = Math.max(0, offset);
        limit = limit <= 0 ? DEFAULT_LIMIT : Math.min(limit, MAX_LIMIT);
    }
}
