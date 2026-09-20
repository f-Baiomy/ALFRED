package com.fathy.alfred.backend.interception.application.port.in;

import com.fathy.alfred.backend.interception.domain.model.InterceptionRule;
import com.fathy.alfred.backend.interception.domain.model.RuleImportResult;

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

    /**
     * Creates every rule in an exported file that can be created, and reports on each one.
     *
     * <p>A batch rather than the client calling {@link #create} per rule, for a reason that is
     * not convenience: each create persists, republishes the whole snapshot to the proxy and
     * pushes a WebSocket event that makes every open page refetch the rule list. A twenty-rule
     * file would do all three twenty times. This does them once.
     *
     * <p>Import always CREATES. There is no merge by id or by name: an id would make the file
     * carry the identity of the database it came from, and a name would silently replace a rule
     * somebody spent an afternoon on. Replacing one is import-then-delete, two visible steps.
     *
     * @param enable whether the imported rules arrive switched on. Defaults off at the boundary:
     *               a file can carry a rule that holds real callers open, and one that starts
     *               applying the instant it lands is the outcome nobody can undo by reading.
     */
    RuleImportResult importRules(List<InterceptionRule> rules, boolean enable);

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
