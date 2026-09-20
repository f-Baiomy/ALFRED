package com.fathy.alfred.backend.interception.application.port.in;

import com.fathy.alfred.backend.interception.domain.model.InterceptionRule;

import java.util.List;
import java.util.Optional;

public interface ManageInterceptionRulesUseCase {

    List<InterceptionRule> list();

    Optional<InterceptionRule> get(String id);

    /** @throws InvalidRuleException if the rule could not be carried out as written. */
    InterceptionRule create(InterceptionRule rule);

    /** Empty when no rule has that id. */
    Optional<InterceptionRule> update(String id, InterceptionRule rule);

    boolean delete(String id);

    Optional<InterceptionRule> setEnabled(String id, boolean enabled);

    /**
     * Reassigns priorities to match the given id order. Ids not in the list keep their relative
     * position after the ones that are, so a reorder sent by a stale page cannot silently drop a
     * rule another tab just created.
     */
    List<InterceptionRule> reorder(List<String> idsInOrder);

    boolean isMasterSwitchOn();

    void setMasterSwitch(boolean on);

    /** Thrown for a rule that would never fire, or could not be applied - see RuleValidator. */
    class InvalidRuleException extends RuntimeException {
        private final transient List<String> problems;

        public InvalidRuleException(List<String> problems) {
            super(String.join(" ", problems));
            this.problems = List.copyOf(problems);
        }

        public List<String> problems() {
            return problems;
        }
    }
}
