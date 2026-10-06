package com.fathy.alfred.backend.triage.domain.model;

import java.util.List;
import java.util.Set;

/**
 * Which calls "problem calls" keeps (specs/010-mcp-log-investigation): every signal in {@code all}, at least one of
 * {@code any} (when given), none of {@code none}; with no signal named, any call with at least one signal.
 * {@code dbFlags} narrows DB_WARNING to these flag names. {@code minStatus} is where an HTTP status becomes an error
 * (400 by default). {@code project}, {@code fromMs}, {@code toMs} narrow by project and start time.
 */
public record ProblemFilter(Set<Signal> all, Set<Signal> any, Set<Signal> none, List<String> dbFlags, int minStatus, String project,
                            Long fromMs, Long toMs) {

    public static final int DEFAULT_MIN_STATUS = 400;

    public ProblemFilter {
        all = all == null ? Set.of() : Set.copyOf(all);
        any = any == null ? Set.of() : Set.copyOf(any);
        none = none == null ? Set.of() : Set.copyOf(none);
        dbFlags = dbFlags == null ? List.of() : List.copyOf(dbFlags);
        minStatus = minStatus <= 0 ? DEFAULT_MIN_STATUS : Math.max(100, Math.min(600, minStatus));
    }

    public static ProblemFilter everything() {
        return new ProblemFilter(null, null, null, null, 0, null, null, null);
    }

    public boolean keeps(List<Signal> signals) {
        if (all.isEmpty() && any.isEmpty() && none.isEmpty()) {
            return !signals.isEmpty();
        }
        return signals.containsAll(all) && (any.isEmpty() || any.stream().anyMatch(signals::contains)) && none.stream().noneMatch(signals::contains);
    }
}
