package com.fathy.alfred.backend.interception.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

/**
 * One arm of an {@code IF_REQUEST} / {@code IF_RESPONSE}: a set of conditions and what to do when
 * they hold.
 *
 * <p>Branches are a LIST rather than a nested if-inside-else, which is what makes "else if"
 * expressible without a tree. They are tried in order and the <b>first match wins</b> - nothing
 * after it runs - so two branches are alternatives, never a sequence. That distinction matters
 * beyond readability: it is why two branches may each end the request without contradicting each
 * other, where two top-level terminal actions would.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ConditionBranch(
        /** ALL (default) or ANY - how this branch's own conditions combine. */
        Combine combine,
        List<Condition> conditions,
        List<RuleAction> actions) {

    public enum Combine { ALL, ANY }

    public ConditionBranch {
        conditions = conditions == null ? List.of() : List.copyOf(conditions);
        actions = actions == null ? List.of() : List.copyOf(actions);
        combine = combine == null ? Combine.ALL : combine;
    }
}
