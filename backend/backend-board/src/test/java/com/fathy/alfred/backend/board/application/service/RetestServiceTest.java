package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.RetestUseCase;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CallFacts;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.CardStatus;
import com.fathy.alfred.backend.board.domain.model.CycleCall;
import com.fathy.alfred.backend.board.domain.model.Expectation;
import com.fathy.alfred.backend.board.domain.model.MentionRef;
import com.fathy.alfred.backend.board.domain.model.MentionType;
import com.fathy.alfred.backend.board.domain.model.RetestCheck;
import com.fathy.alfred.backend.board.domain.model.RetestCheck.Outcome;
import com.fathy.alfred.backend.board.domain.model.RetestCheck.Verdict;
import com.fathy.alfred.backend.board.domain.model.RetestPlan;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/** specs/016: a Fixed card re-tested from the live calls since its fix, against its expectations. */
class RetestServiceTest {

    private static final String ENDPOINT = "POST /Admin2/agency/by-branch";
    private static final Expectation SQL = new Expectation(Expectation.Kind.SQL_COUNT, "TT_COUNTRY_AIRLINE_MAP", 3L, null, null, null, null);
    private static final Expectation NO_ERROR = new Expectation(Expectation.Kind.NO_LOG, null, null, null, "ERROR", null, null);

    @TempDir
    Path dir;
    private BoardFixture f;

    @BeforeEach
    void setUp() {
        f = new BoardFixture(dir);
        f.signatures.put("orig", "ok|" + ENDPOINT);
        f.facts.put("orig", facts(200, 5400.0, 257, 0));
    }

    @AfterEach
    void tearDown() throws Exception {
        f.close();
    }

    private static CallFacts facts(int status, double ms, int countryMaps, int errors) {
        return new CallFacts(status, ms, countryMaps + 5, Map.of("TT_COUNTRY_AIRLINE_MAP", countryMaps, "TT_AGENCY", 5), errors, 0, Map.of());
    }

    /** A Fixed card about the original call, fixed "now". */
    private String fixedCard() {
        String id = f.create(Actor.USER, "odeysys", "N+1 countries", List.of(new MentionRef(MentionType.CALL, "in:orig", "POST /Admin2/agency/by-branch · 200")))
                .card().card().id();
        f.board.move(Actor.USER, id, CardStatus.TO_DO);
        f.board.move(Actor.USER, id, CardStatus.FIXED);
        f.clock.advanceSeconds(60);
        return id;
    }

    private void liveCall(String id, int status, Double ms, CallFacts facts) {
        f.liveCalls.add(0, new CycleCall("in", id, "POST", "/Admin2/agency/by-branch", status, (status >= 500 ? "5xx" : "ok") + "|" + ENDPOINT,
                f.clock.instant(), ms));
        if (facts != null) {
            f.facts.put(id, facts);
        }
        f.clock.advanceSeconds(10);
    }

    private RetestCheck only() {
        List<RetestCheck> checks = f.retest.check("odeysys", List.of(), null);
        assertThat(checks).hasSize(1);
        return checks.get(0);
    }

    @Test
    void aCardWithNoCallSinceItsFixWaitsAndCallsBeforeTheFixDoNotCount() {
        liveCall("before", 200, 5000.0, facts(200, 5000, 257, 0));
        String id = fixedCard();
        f.retest.setPlan(Actor.CLAUDE, id, List.of(SQL), List.of(new RetestPlan.Step("Open the flight search page", null)));

        RetestCheck check = only();
        assertThat(check.verdict()).isEqualTo(Verdict.NO_CALLS);
        assertThat(check.summary()).isEqualTo("no calls since the fix · Open the flight search page");
        assertThat(check.steps()).singleElement().satisfies(s -> assertThat(s.seen()).isFalse());
    }

    @Test
    void theExpectationIsCheckedOnEveryCallWithTheOriginalValueBesideIt() {
        String id = fixedCard();
        f.retest.setPlan(Actor.CLAUDE, id, List.of(SQL, NO_ERROR), List.of(new RetestPlan.Step("Open the flight search page", null)));
        liveCall("a1", 200, 410.0, facts(200, 410, 3, 0));
        liveCall("a2", 200, 380.0, facts(200, 380, 3, 0));

        RetestCheck check = only();
        assertThat(check.verdict()).isEqualTo(Verdict.PASSES);
        assertThat(check.statusOnly()).isFalse();
        assertThat(check.results().get(0).before()).isEqualTo("257");
        assertThat(check.results().get(0).after()).containsExactly("3", "3");
        assertThat(check.results().get(0).outcome()).isEqualTo(Outcome.PASS);
        assertThat(check.summary()).isEqualTo("passes · 2 calls since the fix · ≤ 3 queries on TT_COUNTRY_AIRLINE_MAP: 257 → 3");
        assertThat(check.calls()).extracting(RetestCheck.CallResult::ref).containsExactly("in:a2", "in:a1");
        assertThat(check.steps()).singleElement().satisfies(s -> assertThat(s.seen()).isTrue());
    }

    @Test
    void someCallsFailingIsFlakyAndAllFailingFails() {
        String id = fixedCard();
        f.retest.setPlan(Actor.USER, id, List.of(SQL), List.of());
        liveCall("a1", 200, 400.0, facts(200, 400, 257, 0));
        assertThat(only().verdict()).isEqualTo(Verdict.FAILS);
        assertThat(only().summary()).isEqualTo("fails · ≤ 3 queries on TT_COUNTRY_AIRLINE_MAP: 257");

        liveCall("a2", 200, 400.0, facts(200, 400, 3, 0));
        RetestCheck check = only();
        assertThat(check.verdict()).isEqualTo(Verdict.FLAKY);
        assertThat(check.summary()).startsWith("flaky · passes 1 of 2");
    }

    @Test
    void aDurationNeedsThreeCallsAndUncapturedSqlIsNotAPass() {
        String id = fixedCard();
        f.retest.setPlan(Actor.USER, id, List.of(new Expectation(Expectation.Kind.DURATION, null, 800L, null, null, null, null)), List.of());
        liveCall("a1", 200, 300.0, facts(200, 300, 3, 0));
        RetestCheck check = only();
        assertThat(check.verdict()).isEqualTo(Verdict.PARTIAL);
        assertThat(check.results().get(0).note()).isEqualTo("1 / 3 calls");
        liveCall("a2", 200, 300.0, facts(200, 300, 3, 0));
        liveCall("a3", 200, 300.0, facts(200, 300, 3, 0));
        assertThat(only().verdict()).isEqualTo(Verdict.PASSES);

        f.retest.setPlan(Actor.USER, id, List.of(SQL), List.of());
        f.facts.put("a1", new CallFacts(200, 300.0, null, null, null, null, Map.of()));
        f.facts.put("a2", new CallFacts(200, 300.0, null, null, null, null, Map.of()));
        f.facts.put("a3", new CallFacts(200, 300.0, null, null, null, null, Map.of()));
        check = only();
        assertThat(check.verdict()).isEqualTo(Verdict.PARTIAL);
        assertThat(check.results().get(0).outcome()).isEqualTo(Outcome.UNKNOWN);
        assertThat(check.results().get(0).note()).isEqualTo("◆ database capture did not record the call");
    }

    @Test
    void aCardWithoutExpectationsComparesTheStatusAndSaysSo() {
        f.signatures.put("orig", "5xx|" + ENDPOINT);
        fixedCard();
        liveCall("a1", 200, 300.0, facts(200, 300, 3, 0));
        RetestCheck check = only();
        assertThat(check.statusOnly()).isTrue();
        assertThat(check.verdict()).isEqualTo(Verdict.PASSES);
        assertThat(check.results().get(0).text()).isEqualTo("Status not 5xx (status only - no expectations)");
        liveCall("a2", 500, 300.0, facts(500, 300, 3, 1));
        assertThat(only().verdict()).isEqualTo(Verdict.FLAKY);
    }

    @Test
    void oneCardOrSomeCardsCanBeReTestedAndARunKeepsTheHistoryAndTheReport() {
        String id = fixedCard();
        int number = f.store.find(id).orElseThrow().number();
        f.retest.setPlan(Actor.CLAUDE, id, List.of(SQL), List.of());
        liveCall("a1", 200, 300.0, facts(200, 300, 3, 0));

        assertThat(f.retest.check("odeysys", List.of(number), null)).hasSize(1);
        assertThat(f.retest.check("odeysys", List.of(999), null)).isEmpty();

        RetestUseCase.Report report = f.retest.run(Actor.USER, "odeysys", List.of(number), null);
        assertThat(report.source()).isEqualTo("live");
        assertThat(report.markdown()).contains("**Passed (1)**", "#" + number + " N+1 countries - passes");
        assertThat(f.retest.history(id)).singleElement().satisfies(r -> {
            assertThat(r.verdict()).isEqualTo(Verdict.PASSES);
            assertThat(r.calls()).isEqualTo(1);
        });
        assertThat(f.signals).contains("retest:odeysys:null");
    }

    @Test
    void aReTestCycleNarrowsTheCallsToTheOnesItCaptured() {
        String id = fixedCard();
        f.retest.setPlan(Actor.USER, id, List.of(SQL), List.of());
        liveCall("live1", 200, 300.0, facts(200, 300, 257, 0));
        f.cycleCalls.add(new CycleCall("in", "c1", "POST", "/Admin2/agency/by-branch", 200, "ok|" + ENDPOINT, f.clock.instant(), 300.0));
        f.facts.put("cyc/c1", facts(200, 300, 3, 0));

        List<RetestCheck> checks = f.retest.check("odeysys", List.of(), "cyc");
        assertThat(checks.get(0).verdict()).isEqualTo(Verdict.PASSES);
        assertThat(checks.get(0).calls()).extracting(RetestCheck.CallResult::ref).containsExactly("in:c1@cyc");

        RetestUseCase.Report report = f.retest.run(Actor.USER, "odeysys", List.of(), "cyc");
        assertThat(report.source()).isEqualTo("cycle:cyc");
        assertThat(f.store.log("cyc", 5)).singleElement().satisfies(e -> {
            assertThat(e.skill()).isEqualTo("re-test");
            assertThat(e.found()).contains("**Passed (1)**");
            assertThat(e.next()).isEqualTo("Accept Verified on the 1 passing card");
        });
    }

    @Test
    void aVerifiedCardStaysGuardedByItsExpectations() {
        String id = fixedCard();
        f.retest.setPlan(Actor.USER, id, List.of(SQL), List.of());
        f.board.move(Actor.USER, id, CardStatus.VERIFIED);
        f.clock.advanceSeconds(60);
        assertThat(f.retest.guards("odeysys")).singleElement().satisfies(g -> assertThat(g.verdict()).isEqualTo(Verdict.NO_CALLS));
        liveCall("later", 200, 300.0, facts(200, 300, 212, 0));
        assertThat(f.retest.guards("odeysys")).singleElement().satisfies(g -> assertThat(g.verdict()).isEqualTo(Verdict.FAILS));
    }

    @Test
    void anAppStartAfterTheFixWithNoCallSinceMarksANewBuild() {
        fixedCard();
        f.retest.appStarted("odeysys", f.clock.instant());
        f.clock.advanceSeconds(5);
        assertThat(only().newBuild()).isTrue();
        liveCall("a1", 200, 300.0, facts(200, 300, 3, 0));
        assertThat(only().newBuild()).isFalse();
    }

    @Test
    void thePlanIsValidatedAndClaudeCannotChangeADoneCardsPlan() {
        String id = fixedCard();
        RetestUseCase.PlanChange bad = f.retest.setPlan(Actor.CLAUDE, id,
                List.of(new Expectation(Expectation.Kind.STATUS, null, null, "2yy", null, null, null)), List.of());
        assertThat(bad.outcome()).isEqualTo(CardChange.Outcome.INVALID);
        assertThat(bad.message()).isEqualTo("STATUS needs range: 2xx, 200, !405 or !5xx");
        assertThat(f.retest.setPlan(Actor.CLAUDE, id, List.of(SQL), List.of()).outcome()).isEqualTo(CardChange.Outcome.OK);
        assertThat(f.retest.plan(id).updatedBy()).isEqualTo(Actor.CLAUDE);

        f.board.move(Actor.USER, id, CardStatus.DONE);
        assertThat(f.retest.setPlan(Actor.CLAUDE, id, List.of(), List.of()).outcome()).isEqualTo(CardChange.Outcome.REFUSED_FOR_CLAUDE);
        assertThat(f.retest.setPlan(Actor.USER, id, List.of(), List.of()).outcome()).isEqualTo(CardChange.Outcome.OK);
    }

    @Test
    void statusRangesReadAsPeopleWriteThem() {
        Expectation not405 = new Expectation(Expectation.Kind.STATUS, null, null, "!405", null, null, null);
        assertThat(not405.statusMatches(200)).isTrue();
        assertThat(not405.statusMatches(405)).isFalse();
        Expectation ok = new Expectation(Expectation.Kind.STATUS, null, null, "2xx", null, null, null);
        assertThat(ok.statusMatches(204)).isTrue();
        assertThat(ok.statusMatches(500)).isFalse();
        assertThat(new Expectation(Expectation.Kind.SAME_RESPONSE, null, null, null, null, null, "$.countries.length").problem()).isNull();
        assertThat(new Expectation(Expectation.Kind.SAME_RESPONSE, null, null, null, null, null, "countries").problem()).isNotNull();
    }

    @Test
    void aFinishedCallToAWatchedEndpointSignalsTheCardAndOthersDoNot() throws Exception {
        fixedCard();
        f.signals.clear();
        f.retest.callArrived("odeysys", "GET /other");
        f.retest.callArrived("odeysys", ENDPOINT);
        long until = System.currentTimeMillis() + 3000;
        while (f.signals.isEmpty() && System.currentTimeMillis() < until) {
            Thread.sleep(20);
        }
        Thread.sleep(100);
        assertThat(f.signals).containsExactly("retest:odeysys:null");
    }

    // ------------------------------------------------------------------------------------------------- specs/020

    private void bodies(String id, String request, String response) {
        f.bodies.put(id, new com.fathy.alfred.backend.board.application.port.out.CallFactsPort.CallBodies(200, request, response));
    }

    @Test
    void callsBeforeTheAppStartThatCarriesTheFixAreListedApartNeverCounted() {
        String id = fixedCard();
        f.retest.setPlan(Actor.USER, id, List.of(SQL), List.of());
        liveCall("old1", 200, 300.0, facts(200, 300, 3, 0));
        liveCall("old2", 200, 300.0, facts(200, 300, 3, 0));
        f.retest.appStarted("odeysys", f.clock.instant());
        f.clock.advanceSeconds(5);

        RetestCheck before = only();
        assertThat(before.verdict()).isEqualTo(Verdict.NO_CALLS);
        assertThat(before.beforeBuild()).isEqualTo(2);
        assertThat(before.summary()).startsWith("not re-tested · no call since the fix build").contains("2 calls before the fix build not counted");

        liveCall("new1", 200, 300.0, facts(200, 300, 3, 0));
        RetestCheck after = only();
        assertThat(after.calls()).extracting(RetestCheck.CallResult::ref).containsExactly("in:new1");
        assertThat(after.beforeBuild()).isEqualTo(2);
    }

    @Test
    void aReTestCycleAlsoSkipsTheCallsItCapturedBeforeTheFixBuild() {
        String id = fixedCard();
        f.retest.setPlan(Actor.USER, id, List.of(SQL), List.of());
        f.cycleCalls.add(new CycleCall("in", "c-old", "POST", "/Admin2/agency/by-branch", 200, "ok|" + ENDPOINT, f.clock.instant(), 300.0));
        f.facts.put("cyc/c-old", facts(200, 300, 3, 0));
        f.clock.advanceSeconds(30);
        f.retest.appStarted("odeysys", f.clock.instant());
        f.clock.advanceSeconds(30);
        // a later, unrelated restart does not hide the re-test made on the fix build
        f.cycleCalls.add(new CycleCall("in", "c-new", "POST", "/Admin2/agency/by-branch", 200, "ok|" + ENDPOINT, f.clock.instant(), 300.0));
        f.facts.put("cyc/c-new", facts(200, 300, 3, 0));
        f.clock.advanceSeconds(30);
        f.retest.appStarted("odeysys", f.clock.instant());

        RetestCheck c = f.retest.check("odeysys", List.of(), "cyc").get(0);
        assertThat(c.calls()).extracting(RetestCheck.CallResult::ref).containsExactly("in:c-new@cyc");
        assertThat(c.beforeBuild()).isEqualTo(1);
    }

    @Test
    void aStepTicksOnlyOnACallThatSentWhatItAsks() {
        String id = fixedCard();
        RetestPlan.Step step = new RetestPlan.Step("All Branches, Search", null, List.of(new RetestPlan.When("$.branchIds", "has:-11")));
        f.retest.setPlan(Actor.USER, id, List.of(), List.of(step));
        liveCall("s1", 200, 300.0, facts(200, 300, 3, 0));
        bodies("s1", "{\"branchId\":948,\"agencyIds\":[949]}", "{\"payload\":[{\"id\":1}],\"total\":1}");

        RetestCheck.StepResult open = only().steps().get(0);
        assertThat(open.seen()).isFalse();
        assertThat(open.note()).contains("none sent what the step asks").contains("branchIds has -11").contains("sent branchIds: nothing");

        liveCall("s2", 200, 300.0, facts(200, 300, 3, 0));
        bodies("s2", "{\"branchIds\":[-11],\"agencyIds\":[-11]}", "{\"payload\":[{\"id\":1}],\"total\":1}");
        RetestCheck.StepResult done = only().steps().get(0);
        assertThat(done.seen()).isTrue();
        assertThat(done.calls()).isEqualTo(1);
    }

    @Test
    void aStepRequestIsValidated() {
        String id = fixedCard();
        RetestUseCase.PlanChange bad = f.retest.setPlan(Actor.USER, id, List.of(),
                List.of(new RetestPlan.Step("x", null, List.of(new RetestPlan.When("branchIds", "has:-11")))));
        assertThat(bad.outcome()).isEqualTo(CardChange.Outcome.INVALID);
        bad = f.retest.setPlan(Actor.USER, id, List.of(), List.of(new RetestPlan.Step("x", null, List.of(new RetestPlan.When("$.branchIds", "many")))));
        assertThat(bad.message()).contains("none, one, list, list>=2, present or has:<value>");
    }

    @Test
    void aStepEndpointNoCallEverHitIsSavedWithAWarningAndTheClosestRecordedOne() {
        String id = fixedCard();
        liveCall("r1", 200, 300.0, null);
        RetestUseCase.PlanChange change = f.retest.setPlan(Actor.CLAUDE, id, List.of(),
                List.of(new RetestPlan.Step("Open the agency list", "POST /agency/by-branch"), new RetestPlan.Step("Search", ENDPOINT)));
        assertThat(change.outcome()).isEqualTo(CardChange.Outcome.OK);
        assertThat(change.warnings()).singleElement().asString()
                .contains("No recorded call ever hit POST /agency/by-branch").contains("Did you mean " + ENDPOINT + " (1 call)?");
        assertThat(RetestService.closest("GET /lookup/branches", List.of("GET /Master2/Branch/lookup/branches", "POST /lookup/branches")))
                .isEqualTo("GET /Master2/Branch/lookup/branches");
        assertThat(RetestService.closest("GET /a/b", List.of("GET /x/y"))).isNull();
    }

    @Test
    void everyAnswerEmptyIsSaidAndCounted() {
        String id = fixedCard();
        f.retest.setPlan(Actor.USER, id, List.of(SQL), List.of());
        liveCall("e1", 200, 300.0, facts(200, 300, 3, 0));
        bodies("e1", "{}", "{\"payload\":[],\"total\":0}");
        liveCall("e2", 200, 300.0, facts(200, 300, 3, 0));
        bodies("e2", "{}", "{\"payload\":[],\"total\":0}");
        RetestCheck c = only();
        assertThat(c.emptyAnswers()).isEqualTo(2);
        assertThat(c.onlyEmptyAnswers()).isTrue();
        assertThat(c.summary()).contains("every answer was empty (2 calls, 0 rows)");

        liveCall("e3", 200, 300.0, facts(200, 300, 3, 0));
        bodies("e3", "{}", "{\"payload\":[{\"id\":7}],\"total\":1}");
        assertThat(only().onlyEmptyAnswers()).isFalse();
    }

    @Test
    void aCardAcceptedOnARunThatSawOnlyEmptyAnswersStaysMarkedSo() {
        String id = fixedCard();
        f.retest.setPlan(Actor.USER, id, List.of(SQL), List.of());
        liveCall("v1", 200, 300.0, facts(200, 300, 3, 0));
        bodies("v1", "{}", "{\"payload\":[],\"total\":0}");
        f.retest.run(Actor.USER, "odeysys", List.of(), null);
        f.board.move(Actor.USER, id, CardStatus.VERIFIED);
        f.clock.advanceSeconds(5);
        assertThat(f.retest.guards("odeysys")).singleElement().satisfies(g -> assertThat(g.verifiedOnEmpty()).isTrue());
    }
}
