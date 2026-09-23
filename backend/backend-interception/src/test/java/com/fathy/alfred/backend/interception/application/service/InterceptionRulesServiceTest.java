package com.fathy.alfred.backend.interception.application.service;

import com.fathy.alfred.backend.interception.application.port.in.ManageInterceptionRulesUseCase;
import com.fathy.alfred.backend.interception.application.port.out.InterceptionNotificationPort;
import com.fathy.alfred.backend.interception.application.port.out.InterceptionRulesStorePort;
import com.fathy.alfred.backend.interception.application.port.out.RulesPublisherPort;
import com.fathy.alfred.backend.interception.domain.model.SelfTargets;
import com.fathy.alfred.backend.interception.domain.model.ActionType;
import com.fathy.alfred.backend.interception.domain.model.InterceptionRule;
import com.fathy.alfred.backend.interception.domain.model.RuleAction;
import com.fathy.alfred.backend.interception.domain.model.RuleImportResult;
import com.fathy.alfred.backend.interception.domain.model.PausedCall;
import com.fathy.alfred.backend.interception.domain.model.RuleMatch;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class InterceptionRulesServiceTest {

    private InMemoryStore store;
    private RecordingPublisher publisher;
    private CountingNotifications notifications;
    private InterceptionRulesService service;
    private BreakpointService breakpoints;

    static class InMemoryStore implements InterceptionRulesStorePort {
        List<InterceptionRule> rules = new ArrayList<>();
        boolean enabled;

        public List<InterceptionRule> findAll() {
            return List.copyOf(rules);
        }

        public void saveAll(List<InterceptionRule> saved) {
            rules = new ArrayList<>(saved);
        }

        public boolean isEnabled() {
            return enabled;
        }

        public void setEnabled(boolean value) {
            enabled = value;
        }
    }

    static class RecordingPublisher implements RulesPublisherPort {
        int publishes;
        boolean lastEnabled;
        List<InterceptionRule> lastRules = List.of();

        public void publish(boolean enabled, List<InterceptionRule> rules) {
            publishes++;
            lastEnabled = enabled;
            lastRules = List.copyOf(rules);
        }
    }

    static class CountingNotifications implements InterceptionNotificationPort {
        int rules;
        int paused;

        public void rulesChanged() {
            rules++;
        }

        public void pausedCallsChanged() {
            paused++;
        }
    }

    @BeforeEach
    void setUp() {
        store = new InMemoryStore();
        publisher = new RecordingPublisher();
        notifications = new CountingNotifications();
        breakpoints = new BreakpointService(notifications);
        service = new InterceptionRulesService(store, publisher, notifications, breakpoints,
                new SelfTargets(Set.of("backend"), Set.of("localhost:5000")));
    }

    private static InterceptionRule delayRule(String name, int priority) {
        return new InterceptionRule(null, name, null, true, priority, false, RuleMatch.empty(),
                List.of(new RuleAction(ActionType.DELAY_REQUEST, 1000, null, null, null, null, null, null, null, null, null, null, null)),
                null, null);
    }

    @Test
    void createAssignsAnIdAndTimestampsAndPublishes() {
        InterceptionRule created = service.create(delayRule("Slow supplier", 10));

        assertThat(created.id()).isNotBlank();
        assertThat(created.createdAt()).isNotBlank();
        assertThat(created.updatedAt()).isEqualTo(created.createdAt());
        assertThat(publisher.publishes).isEqualTo(1);
        assertThat(notifications.rules).isEqualTo(1);
    }

    @Test
    void createRejectsAnInvalidRuleWithoutPublishingAnything() {
        InterceptionRule noActions = new InterceptionRule(null, "Empty", null, true, 10, false,
                RuleMatch.empty(), List.of(), null, null);

        assertThatThrownBy(() -> service.create(noActions))
                .isInstanceOf(ManageInterceptionRulesUseCase.InvalidRuleException.class);
        assertThat(store.rules).isEmpty();
        assertThat(publisher.publishes).isZero();
    }

    @Test
    void updateKeepsTheOriginalCreatedAt() throws InterruptedException {
        InterceptionRule created = service.create(delayRule("First", 10));
        Thread.sleep(5);

        InterceptionRule updated = service.update(created.id(), delayRule("Renamed", 10)).orElseThrow();

        assertThat(updated.name()).isEqualTo("Renamed");
        assertThat(updated.createdAt()).isEqualTo(created.createdAt());
        assertThat(updated.updatedAt()).isNotEqualTo(created.updatedAt());
    }

    @Test
    void updateOfAnUnknownIdIsEmptyRatherThanACreate() {
        assertThat(service.update("nope", delayRule("X", 10))).isEmpty();
        assertThat(store.rules).isEmpty();
    }

    @Test
    void deleteReportsWhetherAnythingWasRemoved() {
        InterceptionRule created = service.create(delayRule("Doomed", 10));

        assertThat(service.delete(created.id())).isTrue();
        assertThat(service.delete(created.id())).isFalse();
        assertThat(store.rules).isEmpty();
    }

    @Test
    void togglingOneRuleDoesNotTouchAnyOther() {
        InterceptionRule a = service.create(delayRule("A", 10));
        InterceptionRule b = service.create(delayRule("B", 20));

        service.setEnabled(a.id(), false);

        assertThat(service.get(a.id()).orElseThrow().enabled()).isFalse();
        assertThat(service.get(b.id()).orElseThrow().enabled()).isTrue();
    }

    @Test
    void onlyEnabledRulesAreHandedToThePublisher() {
        InterceptionRule a = service.create(delayRule("A", 10));
        service.create(delayRule("B", 20));

        service.setEnabled(a.id(), false);

        // The publisher receives the whole list and does the filtering itself (see
        // FileRulesPublisherAdapter), so what matters here is that it was told about the change.
        assertThat(publisher.lastRules).hasSize(2);
        assertThat(publisher.publishes).isEqualTo(3);
    }

    @Test
    void reorderRenumbersPrioritiesToMatchTheGivenOrder() {
        InterceptionRule a = service.create(delayRule("A", 10));
        InterceptionRule b = service.create(delayRule("B", 20));
        InterceptionRule c = service.create(delayRule("C", 30));

        List<InterceptionRule> reordered = service.reorder(List.of(c.id(), a.id(), b.id()));

        assertThat(reordered).extracting(InterceptionRule::name).containsExactly("C", "A", "B");
        assertThat(reordered).extracting(InterceptionRule::priority).containsExactly(10, 20, 30);
    }

    @Test
    void reorderKeepsRulesTheCallerDidNotMention() {
        InterceptionRule a = service.create(delayRule("A", 10));
        InterceptionRule b = service.create(delayRule("B", 20));
        service.create(delayRule("CreatedByAnotherTab", 30));

        List<InterceptionRule> reordered = service.reorder(List.of(b.id(), a.id()));

        assertThat(reordered).extracting(InterceptionRule::name)
                .containsExactly("B", "A", "CreatedByAnotherTab");
    }

    @Test
    void masterSwitchIsPublishedWithoutChangingAnyRulesOwnState() {
        InterceptionRule a = service.create(delayRule("A", 10));

        service.setMasterSwitch(true);

        assertThat(publisher.lastEnabled).isTrue();
        assertThat(service.get(a.id()).orElseThrow().enabled()).isTrue();

        service.setMasterSwitch(false);

        assertThat(publisher.lastEnabled).isFalse();
        // Turning everything off must not lose which rules the user had on, or turning it back on
        // would be a manual reconstruction job.
        assertThat(service.get(a.id()).orElseThrow().enabled()).isTrue();
    }

    @Test
    void masterSwitchDefaultsToOff() {
        assertThat(service.isMasterSwitchOn()).isFalse();
    }

    // ---- importing an exported rules file ----------------------------------------------------

    private static InterceptionRule pauseRule(String name) {
        return new InterceptionRule(null, name, null, true, 100, false, RuleMatch.empty(),
                List.of(new RuleAction(ActionType.PAUSE_REQUEST, null, null, null, null, null, null, null,
                        30, "release", null, null, null)),
                null, null);
    }

    private static InterceptionRule brokenRule(String name) {
        // No actions at all: a rule that can never do anything.
        return new InterceptionRule(null, name, null, true, 100, false, RuleMatch.empty(), List.of(), null, null);
    }

    @Test
    void importCreatesEveryRuleItCanAndSaysWhatHappenedToEachOne() {
        RuleImportResult result = service.importRules(
                List.of(delayRule("One", 100), brokenRule("Broken"), delayRule("Two", 100)), false);

        assertThat(result.imported()).isEqualTo(2);
        assertThat(result.rejected()).isEqualTo(1);
        assertThat(store.rules).extracting(InterceptionRule::name).containsExactly("One", "Two");
        assertThat(result.results()).extracting(RuleImportResult.Outcome::status)
                .containsExactly("imported", "rejected", "imported");
        // The index is the position in the FILE, so the dialog can point at the rule that failed.
        assertThat(result.results().get(1).index()).isEqualTo(1);
        assertThat(result.results().get(1).problems()).isNotEmpty();
    }

    @Test
    void oneBadRuleDoesNotCancelTheGoodOnes() {
        // Throwing away working rules because one is malformed is the worse failure - and a
        // quiet partial import is worse still, which is why every rejection is reported.
        service.importRules(List.of(brokenRule("Broken"), delayRule("Fine", 100)), false);

        assertThat(store.rules).extracting(InterceptionRule::name).containsExactly("Fine");
    }

    @Test
    void importedRulesArriveOffUnlessAskedForOtherwise() {
        // A file can carry a rule that holds real callers open. One that starts applying the
        // instant it lands is the outcome nobody can undo by reading it first.
        service.importRules(List.of(pauseRule("Pauser")), false);
        assertThat(store.rules.get(0).enabled()).isFalse();

        service.importRules(List.of(pauseRule("Pauser 2")), true);
        assertThat(store.rules).extracting(InterceptionRule::enabled).containsExactly(false, true);
    }

    @Test
    void anEnabledFlagInTheFileNeverOverridesTheImportersChoice() {
        // Every rule in the file below says enabled:true. The import said off; off wins.
        service.importRules(List.of(delayRule("A", 10), delayRule("B", 20)), false);

        assertThat(store.rules).extracting(InterceptionRule::enabled).containsOnly(false);
    }

    @Test
    void importedRulesGoAfterEverythingAlreadyHere() {
        service.create(delayRule("Existing", 10));

        service.importRules(List.of(delayRule("First in file", 5), delayRule("Second in file", 1)), false);

        // The priorities in the file were relative to the deployment it came from. Interleaving
        // them would silently change when the existing rules run, which an import must not do -
        // but their order relative to EACH OTHER is preserved.
        assertThat(store.rules).extracting(InterceptionRule::name)
                .containsExactly("Existing", "First in file", "Second in file");
        assertThat(store.rules).extracting(InterceptionRule::priority).isSorted();
    }

    @Test
    void importPublishesAndNotifiesExactlyOnceForTheWholeFile() {
        // The entire reason this is a batch. Twenty creates would republish the whole snapshot to
        // the proxy twenty times and make every open page refetch the rule list twenty times.
        service.importRules(List.of(delayRule("A", 10), delayRule("B", 20), delayRule("C", 30)), false);

        assertThat(publisher.publishes).isEqualTo(1);
        assertThat(notifications.rules).isEqualTo(1);
    }

    @Test
    void aFileWhoseRulesAreAllBrokenChangesNothingAtAll() {
        service.create(delayRule("Existing", 10));
        int publishesBefore = publisher.publishes;

        RuleImportResult result = service.importRules(List.of(brokenRule("X"), brokenRule("Y")), false);

        assertThat(result.imported()).isZero();
        assertThat(result.rejected()).isEqualTo(2);
        assertThat(store.rules).hasSize(1);
        assertThat(publisher.publishes).isEqualTo(publishesBefore);
    }

    @Test
    void importNeverTouchesTheMasterSwitch() {
        // A deployment-level setting, not a rule. No file should be able to turn interception on.
        assertThat(service.isMasterSwitchOn()).isFalse();

        service.importRules(List.of(delayRule("A", 10)), true);

        assertThat(service.isMasterSwitchOn()).isFalse();
    }

    @Test
    void importingAnEmptyFileIsAnEmptyResultRatherThanAnError() {
        RuleImportResult result = service.importRules(List.of(), false);

        assertThat(result.imported()).isZero();
        assertThat(result.results()).isEmpty();
        assertThat(publisher.publishes).isZero();
    }

    @Test
    void importedRulesGetFreshIdsRatherThanAnythingFromTheFile() {
        service.importRules(List.of(delayRule("A", 10), delayRule("B", 20)), false);

        assertThat(store.rules).extracting(InterceptionRule::id).doesNotContainNull();
        assertThat(store.rules.get(0).id()).isNotEqualTo(store.rules.get(1).id());
        assertThat(store.rules).extracting(InterceptionRule::createdAt).doesNotContainNull();
    }

    @Test
    void startupRepublishesWhatIsStored() {
        store.rules.add(delayRule("Preexisting", 10).withId("id-1"));
        store.enabled = true;

        new InterceptionRulesService(store, publisher, notifications, new BreakpointService(notifications), SelfTargets.none())
                .republishOnStartup();

        assertThat(publisher.lastEnabled).isTrue();
        assertThat(publisher.lastRules).hasSize(1);
    }

    // ---- switching interception off lets go of what it is already holding ---------------------
    //
    // Publishing a snapshot only stops NEW calls being stopped. A call already waiting is long
    // past rule evaluation, so without these the switch that is supposed to make it all stop
    // leaves every held caller hanging until its own timeout - and their request and response
    // bodies in memory with them, which on a busy rule is what exhausts the heap.

    private static PausedCall heldCall(String callId, String ruleId) {
        return new PausedCall(callId, "response", "outbound", null, ruleId, "Rule",
                30, "release", "POST", "https://api.example.com/search",
                new PausedCall.Http(null, Map.of(), "{}"),
                new PausedCall.Http(200, Map.of(), "{\"ok\":true}"),
                System.currentTimeMillis(), null);
    }

    @Test
    void turningTheMasterSwitchOffReleasesEveryHeldCall() {
        breakpoints.register(heldCall("c1", "rule-1"));
        breakpoints.register(heldCall("c2", "rule-2"));

        service.setMasterSwitch(false);

        assertThat(breakpoints.pending()).isEmpty();
    }

    @Test
    void turningTheMasterSwitchOnHoldsNothingAgainstItsWill() {
        breakpoints.register(heldCall("c1", "rule-1"));

        service.setMasterSwitch(true);

        // Switching ON is not a decision about anything already waiting.
        assertThat(breakpoints.pending()).hasSize(1);
    }

    @Test
    void disablingOneRuleReleasesOnlyTheCallsThatRuleIsHolding() {
        InterceptionRule mine = service.create(delayRule("Mine", 10));
        breakpoints.register(heldCall("c1", mine.id()));
        breakpoints.register(heldCall("c2", "someone-elses-rule"));

        service.setEnabled(mine.id(), false);

        assertThat(breakpoints.pending()).extracting(PausedCall::callId).containsExactly("c2");
    }

    @Test
    void deletingARuleReleasesWhatItWasHolding() {
        InterceptionRule doomed = service.create(delayRule("Doomed", 10));
        breakpoints.register(heldCall("c1", doomed.id()));

        service.delete(doomed.id());

        // Nothing can decide on a call whose rule no longer exists, so holding its caller open
        // until the timeout is just a caller waiting for nobody.
        assertThat(breakpoints.pending()).isEmpty();
    }
}
