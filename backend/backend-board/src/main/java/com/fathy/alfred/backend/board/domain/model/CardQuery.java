package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;
import java.util.Set;

/**
 * A board list request; every limit is clamped here so no caller can ask for unbounded work. {@code allProjects}
 * searches every board (Claude's "what am I working on"), {@code since} keeps cards changed at or after it, and
 * {@code claudeTouched} keeps cards with any history entry by Claude.
 */
public record CardQuery(String project, String cycleId, Set<CardKind> kinds, Set<CardStatus> statuses, Set<Flag> flags,
                        Actor author, boolean scopeNotDecided, String q, int offset, int limit, boolean allProjects,
                        Instant since, boolean claudeTouched) {

    public CardQuery(String project, String cycleId, Set<CardKind> kinds, Set<CardStatus> statuses, Set<Flag> flags,
                     Actor author, boolean scopeNotDecided, String q, int offset, int limit) {
        this(project, cycleId, kinds, statuses, flags, author, scopeNotDecided, q, offset, limit, false, null, false);
    }

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
