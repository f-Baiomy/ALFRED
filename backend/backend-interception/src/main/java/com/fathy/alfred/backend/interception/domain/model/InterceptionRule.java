package com.fathy.alfred.backend.interception.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * One interception rule: what to match, and what to do about it.
 *
 * <p>{@code priority} decides the order rules run in when several match the same call - ascending,
 * ties broken by the stored order, which is the order the UI lists them in. ALL matching rules
 * apply; a rule does not consume a call. That is the least surprising reading of "delay this
 * supplier" plus "tag every call from this project", which are two independent intentions about
 * the same request, and it is what {@code stopProcessing} exists to override when a user really
 * does want one rule to be the last word.
 *
 * <p>{@code hitCount}/{@code lastHitAt} are NOT maintained here - the proxy is the only thing that
 * knows a rule fired, and it reports that through the existing call webhook rather than writing
 * back into this store on every request. The UI derives them from logged calls.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record InterceptionRule(
        String id,
        String name,
        String description,
        boolean enabled,
        int priority,
        /** Stop evaluating further rules for this call once this one has matched. */
        boolean stopProcessing,
        RuleMatch match,
        List<RuleAction> actions,
        /** The logged call this rule was made from ("⚡+ Rule" on a call card) - a link back, never used to match. */
        SourceCallRef sourceCall,
        String createdAt,
        String updatedAt) {

    public InterceptionRule {
        match = match == null ? RuleMatch.empty() : match;
        actions = actions == null ? List.of() : List.copyOf(actions);
    }

    /** The shape before a rule could remember the call it was made from. */
    public InterceptionRule(String id, String name, String description, boolean enabled, int priority, boolean stopProcessing,
                            RuleMatch match, List<RuleAction> actions, String createdAt, String updatedAt) {
        this(id, name, description, enabled, priority, stopProcessing, match, actions, null, createdAt, updatedAt);
    }

    public InterceptionRule withId(String newId) {
        return new InterceptionRule(newId, name, description, enabled, priority, stopProcessing,
                match, actions, sourceCall, createdAt, updatedAt);
    }

    public InterceptionRule withEnabled(boolean value) {
        return new InterceptionRule(id, name, description, value, priority, stopProcessing,
                match, actions, sourceCall, createdAt, updatedAt);
    }

    public InterceptionRule withPriority(int value) {
        return new InterceptionRule(id, name, description, enabled, value, stopProcessing,
                match, actions, sourceCall, createdAt, updatedAt);
    }

    public InterceptionRule withTimestamps(String created, String updated) {
        return new InterceptionRule(id, name, description, enabled, priority, stopProcessing,
                match, actions, sourceCall, created, updated);
    }

    /** Whether this rule can hold a caller's connection open waiting for a human. */
    public boolean pauses() {
        return actions.stream().anyMatch(a -> a.type() != null && a.type().isPause());
    }

    /** Every stored answer this rule's actions refer to, nested branches included. */
    public Set<String> answerIds() {
        Set<String> ids = new LinkedHashSet<>();
        collectAnswerIds(actions, ids);
        return ids;
    }

    /** Every stored answer any of these rules refers to. */
    public static Set<String> answerIdsOf(Collection<InterceptionRule> rules) {
        Set<String> ids = new LinkedHashSet<>();
        for (InterceptionRule rule : rules) {
            ids.addAll(rule.answerIds());
        }
        return ids;
    }

    private static void collectAnswerIds(List<RuleAction> actions, Set<String> ids) {
        if (actions == null) {
            return;
        }
        for (RuleAction action : actions) {
            if (action == null) {
                continue;
            }
            if (action.answerId() != null && !action.answerId().isBlank()) {
                ids.add(action.answerId());
            }
            collectAnswerIds(action.nested(), ids);
        }
    }
}
