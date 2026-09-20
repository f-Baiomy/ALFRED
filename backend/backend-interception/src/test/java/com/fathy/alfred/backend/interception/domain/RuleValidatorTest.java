package com.fathy.alfred.backend.interception.domain;

import com.fathy.alfred.backend.interception.domain.model.ActionType;
import com.fathy.alfred.backend.interception.domain.model.Condition;
import com.fathy.alfred.backend.interception.domain.model.ConditionBranch;
import com.fathy.alfred.backend.interception.domain.model.ConditionOperator;
import com.fathy.alfred.backend.interception.domain.model.ConditionSubject;
import com.fathy.alfred.backend.interception.domain.model.InterceptionRule;
import com.fathy.alfred.backend.interception.domain.model.RuleAction;
import com.fathy.alfred.backend.interception.domain.model.RuleMatch;
import com.fathy.alfred.backend.interception.domain.model.RuleValidator;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class RuleValidatorTest {

    private static InterceptionRule rule(RuleMatch match, RuleAction... actions) {
        return new InterceptionRule(null, "A rule", null, true, 100, false, match, List.of(actions), null, null);
    }

    private static RuleAction delay(int ms) {
        return new RuleAction(ActionType.DELAY_REQUEST, ms, null, null, null, null, null, null, null, null, null, null, null);
    }

    private static RuleAction pause(int seconds, String onTimeout) {
        return new RuleAction(ActionType.PAUSE_RESPONSE, null, null, null, null, null, null, null, seconds, onTimeout, null, null, null);
    }

    @Test
    void acceptsAMinimalDelayRule() {
        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), delay(5000)))).isEmpty();
    }

    @Test
    void rejectsARuleWithNoActions() {
        assertThat(RuleValidator.validate(rule(RuleMatch.empty())))
                .anyMatch(p -> p.contains("at least one action"));
    }

    @Test
    void rejectsAnUnnamedRule() {
        InterceptionRule unnamed = new InterceptionRule(null, "  ", null, true, 100, false,
                RuleMatch.empty(), List.of(delay(1)), null, null);
        assertThat(RuleValidator.validate(unnamed)).anyMatch(p -> p.contains("needs a name"));
    }

    @Test
    void rejectsANegativeDelayAndOneOverTheCeiling() {
        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), delay(-1)))).isNotEmpty();
        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), delay(RuleValidator.MAX_DELAY_MS + 1))))
                .anyMatch(p -> p.contains("capped"));
    }

    @Test
    void rejectsARegexThatDoesNotCompile() {
        RuleMatch match = new RuleMatch(null, null, List.of(), List.of(), null, null, "([unclosed");
        assertThat(RuleValidator.validate(rule(match, delay(1))))
                .anyMatch(p -> p.contains("does not compile"));
    }

    @Test
    void acceptsARegexThatDoesCompile() {
        RuleMatch match = new RuleMatch(null, null, List.of(), List.of(), null, null, "/v\\d+/order");
        assertThat(RuleValidator.validate(rule(match, delay(1)))).isEmpty();
    }

    @Test
    void rejectsTwoTerminalActionsInOneRule() {
        RuleAction abort = RuleAction.of(ActionType.ABORT_REQUEST);
        RuleAction mock = new RuleAction(ActionType.MOCK_RESPONSE, null, null, null, null, 500,
                Map.of(), "{}", null, null, null, null, null);
        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), abort, mock)))
                .anyMatch(p -> p.contains("only end a request once"));
    }

    @Test
    void rejectsATerminalActionCombinedWithAPause() {
        RuleAction abort = RuleAction.of(ActionType.ABORT_REQUEST);
        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), abort, pause(30, "release"))))
                .anyMatch(p -> p.contains("never reaches a pause"));
    }

    @Test
    void rejectsAPauseWithNoTimeout() {
        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), pause(0, "release"))))
                .anyMatch(p -> p.contains("hold its caller open forever"));
    }

    @Test
    void rejectsAPauseLongerThanTheCeiling() {
        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), pause(RuleValidator.MAX_PAUSE_SECONDS + 1, "release"))))
                .anyMatch(p -> p.contains("at most"));
    }

    @Test
    void rejectsAnUnknownOnTimeout() {
        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), pause(30, "explode"))))
                .anyMatch(p -> p.contains("release or abort"));
    }

    @Test
    void acceptsSendToHostFollowedByResponseHandling() {
        RuleAction send = RuleAction.of(ActionType.SEND_TO_HOST);
        RuleAction replace = new RuleAction(ActionType.REPLACE_RESPONSE, null, null, null, null, 500,
                null, "{\"error\":\"nope\"}", null, null, null, null, null);
        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), send, replace))).isEmpty();
    }

    @Test
    void rejectsARuleThatBothSendsToTheHostAndShortCircuits() {
        RuleAction send = RuleAction.of(ActionType.SEND_TO_HOST);
        RuleAction mock = new RuleAction(ActionType.MOCK_RESPONSE, null, null, null, null, 500,
                Map.of(), "{}", null, null, null, null, null);
        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), send, mock)))
                .anyMatch(p -> p.contains("short-circuits it"));
    }

    @Test
    void rejectsAReplaceResponseThatReplacesNothing() {
        RuleAction empty = RuleAction.of(ActionType.REPLACE_RESPONSE);
        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), empty)))
                .anyMatch(p -> p.contains("at least a status"));
    }

    @Test
    void acceptsAReplaceResponseThatOnlyChangesTheStatus() {
        RuleAction statusOnly = new RuleAction(ActionType.REPLACE_RESPONSE, null, null, null, null, 503,
                null, null, null, null, null, null, null);
        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), statusOnly))).isEmpty();
    }

    @Test
    void rejectsASetResponseBodyWithNoBody() {
        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), RuleAction.of(ActionType.SET_RESPONSE_BODY))))
                .anyMatch(p -> p.contains("needs a body"));
    }

    @Test
    void acceptsBlankingAResponseBodyDeliberately() {
        RuleAction blank = new RuleAction(ActionType.SET_RESPONSE_BODY, null, null, null, null, null,
                null, "", null, null, null, null, null);
        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), blank))).isEmpty();
    }

    @Test
    void rejectsAHeaderActionWithNoName() {
        RuleAction action = new RuleAction(ActionType.SET_REQUEST_HEADER, null, " ", "v", null, null, null, null, null, null, null, null, null);
        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), action))).anyMatch(p -> p.contains("needs a name"));
    }

    @Test
    void rejectsAStatusOutsideTheHttpRange() {
        RuleAction action = new RuleAction(ActionType.SET_RESPONSE_STATUS, null, null, null, null, 42,
                null, null, null, null, null, null, null);
        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), action))).anyMatch(p -> p.contains("100 and 599"));
    }

    @Test
    void reportsEveryProblemAtOnceRatherThanTheFirst() {
        InterceptionRule bad = new InterceptionRule(null, "", null, true, 100, false,
                new RuleMatch(null, null, List.of(), List.of(), null, null, "([bad"), List.of(delay(-5)), null, null);
        assertThat(RuleValidator.validate(bad)).hasSizeGreaterThanOrEqualTo(3);
    }

    /**
     * The same corpus proxy/interception.py's _parse_path handles. These two must agree: a path
     * this accepts and the engine cannot walk is a rule that saves cleanly and never fires.
     */
    @Test
    void acceptsTheDottedPathSubsetTheEngineImplements() {
        for (String path : List.of("currency", "a.b.c", "itinerary.seatsRemaining",
                "segments[0].cabin", "segments[*].cabin", "a[0][1].b", "a[-1].b")) {
            RuleAction action = new RuleAction(ActionType.SET_REQUEST_JSON_FIELD, null, null, 1, path,
                    null, null, null, null, null, null, null, null);
            assertThat(RuleValidator.validate(rule(RuleMatch.empty(), action)))
                    .as("path %s", path)
                    .isEmpty();
        }
    }

    private static RuleAction failure(String mode, Integer durationMs, Integer status, String body) {
        return new RuleAction(ActionType.SIMULATE_FAILURE, durationMs, null, null, null, status,
                null, body, null, null, mode, null, null);
    }

    @Test
    void acceptsEveryFailureModeGivenWhatItNeeds() {
        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), failure("CONNECTION_RESET", null, null, null))))
                .isEmpty();
        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), failure("HANG_THEN_DROP", 5000, null, null))))
                .isEmpty();
        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), failure("HANG_UNTIL_CALLER_GIVES_UP", null, null, null))))
                .isEmpty();
        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), failure("EMPTY_REPLY", null, null, null))))
                .isEmpty();
        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), failure("TRUNCATED_BODY", null, null, "{\"a\":1}"))))
                .isEmpty();
        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), failure("GATEWAY_ERROR", null, 504, null))))
                .isEmpty();
    }

    @Test
    void rejectsAFailureItCannotActuallyReproduce() {
        // A caller is connected to Alfred, whose handshake with it already succeeded - a TLS or
        // DNS error cannot be shown to it, and pretending otherwise in a dropdown would be worse
        // than not offering it.
        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), failure("TLS_HANDSHAKE_FAILED", null, null, null))))
                .anyMatch(problem -> problem.contains("not a failure Alfred can reproduce"));
    }

    @Test
    void rejectsAFailureWithNothingChosen() {
        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), RuleAction.of(ActionType.SIMULATE_FAILURE))))
                .anyMatch(problem -> problem.contains("what goes wrong"));
    }

    @Test
    void requiresADurationOnlyForTheModeThatWaits() {
        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), failure("HANG_THEN_DROP", null, null, null))))
                .anyMatch(problem -> problem.contains("duration"));
        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), failure("CONNECTION_RESET", null, null, null))))
                .isEmpty();
    }

    @Test
    void refusesAGatewayStatusThatIsNotOne() {
        // 500 is the supplier answering, not the gateway failing to reach it - a different thing
        // to be testing, and MOCK_RESPONSE is where it belongs.
        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), failure("GATEWAY_ERROR", null, 500, null))))
                .anyMatch(problem -> problem.contains("502, 503 or 504"));
    }

    @Test
    void refusesToTruncateNothing() {
        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), failure("TRUNCATED_BODY", null, null, ""))))
                .anyMatch(problem -> problem.contains("empty reply"));
    }

    @Test
    void treatsAFailureAsTerminalLikeAnyOtherEnding() {
        RuleAction mock = new RuleAction(ActionType.MOCK_RESPONSE, null, null, null, null, 500,
                null, null, null, null, null, null, null);

        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), failure("CONNECTION_RESET", null, null, null), mock)))
                .anyMatch(problem -> problem.contains("only end a request once"));
    }

    @Test
    void foldsAProjectNameSavedBeforeTheFieldWasAListIntoTheList() {
        // Old rules keep matching exactly what they used to, and there is one shape in storage,
        // in the published snapshot and in the engine rather than two.
        RuleMatch legacy = new RuleMatch(null, "Core-service", null, List.of(), null, null, null);

        assertThat(legacy.serviceNames()).containsExactly("Core-service");
        assertThat(legacy.serviceName()).isNull();
    }

    @Test
    void prefersTheListWhenBothAreSomehowPresent() {
        RuleMatch both = new RuleMatch(null, "Core-service", List.of("odeysys"), List.of(), null, null, null);

        assertThat(both.serviceNames()).containsExactly("odeysys");
    }

    @Test
    void rejectsABlankProjectName() {
        RuleMatch match = new RuleMatch(null, null, List.of("  "), List.of(), null, null, null);

        assertThat(RuleValidator.validate(rule(match, delay(1))))
                .anyMatch(problem -> problem.contains("project name"));
    }

    @Test
    void rejectsMalformedPaths() {
        for (String path : List.of(".a", "a.", "a..b", "[0]", "a[", "a[]", "a[x]", "a]b")) {
            RuleAction action = new RuleAction(ActionType.SET_REQUEST_JSON_FIELD, null, null, 1, path,
                    null, null, null, null, null, null, null, null);
            assertThat(RuleValidator.validate(rule(RuleMatch.empty(), action)))
                    .as("path %s", path)
                    .isNotEmpty();
        }
    }

    // ---- conditions ---------------------------------------------------------------------

    private static Condition condition(ConditionSubject subject, String name,
                                       ConditionOperator operator, String value) {
        return new Condition(subject, name, operator, value, null);
    }

    private static RuleAction conditional(ActionType type, List<ConditionBranch> branches,
                                          List<RuleAction> otherwise) {
        return new RuleAction(type, null, null, null, null, null, null, null, null, null, null,
                branches, otherwise);
    }

    private static ConditionBranch branch(Condition condition, RuleAction... actions) {
        return new ConditionBranch(null, List.of(condition), List.of(actions));
    }

    private static RuleAction setHeader(String name) {
        return new RuleAction(ActionType.SET_REQUEST_HEADER, null, name, "v", null, null, null,
                null, null, null, null, null, null);
    }

    @Test
    void acceptsAnIfElseRule() {
        RuleAction action = conditional(
                ActionType.IF_REQUEST,
                List.of(branch(condition(ConditionSubject.REQUEST_HEADER, "x-api-key",
                        ConditionOperator.NOT_EXISTS, null), setHeader("X-Flagged"))),
                List.of(setHeader("X-Normal")));

        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), action))).isEmpty();
    }

    @Test
    void rejectsAConditionalWithNoBranches() {
        assertThat(RuleValidator.validate(rule(RuleMatch.empty(),
                conditional(ActionType.IF_REQUEST, List.of(), null))))
                .anyMatch(problem -> problem.contains("at least one IF branch"));
    }

    @Test
    void rejectsABranchWithNoConditions() {
        // It would always match and swallow every branch below it, which reads as a bug rather
        // than as an else.
        ConditionBranch empty = new ConditionBranch(null, List.of(), List.of(setHeader("X-A")));

        assertThat(RuleValidator.validate(rule(RuleMatch.empty(),
                conditional(ActionType.IF_REQUEST, List.of(empty), null))))
                .anyMatch(problem -> problem.contains("always matches"));
    }

    @Test
    void rejectsABranchThatDoesNothing() {
        ConditionBranch idle = new ConditionBranch(null,
                List.of(condition(ConditionSubject.METHOD, null, ConditionOperator.EQUALS, "GET")), List.of());

        assertThat(RuleValidator.validate(rule(RuleMatch.empty(),
                conditional(ActionType.IF_REQUEST, List.of(idle), null))))
                .anyMatch(problem -> problem.contains("has no effect"));
    }

    @Test
    void refusesAResponseSubjectInTheRequestHalf() {
        // There is no response yet, so the branch could only ever be false - better refused at
        // save time than left to puzzle someone later.
        RuleAction action = conditional(ActionType.IF_REQUEST,
                List.of(branch(condition(ConditionSubject.RESPONSE_STATUS, null,
                        ConditionOperator.EQUALS, "500"), setHeader("X-A"))),
                null);

        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), action)))
                .anyMatch(problem -> problem.contains("before the response exists"));
    }

    @Test
    void allowsARequestSubjectInTheResponseHalf() {
        // The opposite direction is one of the main reasons to have conditions: "we sent X and
        // got back Y".
        RuleAction setStatus = new RuleAction(ActionType.SET_RESPONSE_STATUS, null, null, null, null,
                200, null, null, null, null, null, null, null);
        RuleAction action = conditional(ActionType.IF_RESPONSE,
                List.of(branch(condition(ConditionSubject.REQUEST_HEADER, "x-env",
                        ConditionOperator.EQUALS, "test"), setStatus)),
                null);

        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), action))).isEmpty();
    }

    @Test
    void refusesAnActionFromTheWrongPhaseInsideABranch() {
        RuleAction setStatus = new RuleAction(ActionType.SET_RESPONSE_STATUS, null, null, null, null,
                500, null, null, null, null, null, null, null);
        RuleAction action = conditional(ActionType.IF_REQUEST,
                List.of(branch(condition(ConditionSubject.METHOD, null, ConditionOperator.EQUALS, "GET"), setStatus)),
                null);

        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), action)))
                .anyMatch(problem -> problem.contains("cannot go inside IF_REQUEST"));
    }

    @Test
    void validatesTheActionsInsideABranchLikeAnyOther() {
        RuleAction badDelay = new RuleAction(ActionType.DELAY_REQUEST, -5, null, null, null, null,
                null, null, null, null, null, null, null);
        RuleAction action = conditional(ActionType.IF_REQUEST,
                List.of(branch(condition(ConditionSubject.METHOD, null, ConditionOperator.EQUALS, "GET"), badDelay)),
                null);

        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), action)))
                .anyMatch(problem -> problem.contains("duration of 0 ms or more"));
    }

    @Test
    void letsTwoBranchesEachEndTheRequest() {
        // Branches are alternatives, never a sequence - only one ever runs - so this is coherent
        // where two terminals in a row would be a contradiction.
        RuleAction mock = new RuleAction(ActionType.MOCK_RESPONSE, null, null, null, null, 500,
                null, null, null, null, null, null, null);
        RuleAction fail = new RuleAction(ActionType.SIMULATE_FAILURE, null, null, null, null, null,
                null, null, null, null, "CONNECTION_RESET", null, null);
        RuleAction action = conditional(ActionType.IF_REQUEST, List.of(
                branch(condition(ConditionSubject.METHOD, null, ConditionOperator.EQUALS, "GET"), mock),
                branch(condition(ConditionSubject.METHOD, null, ConditionOperator.EQUALS, "POST"), fail)), null);

        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), action))).isEmpty();
    }

    @Test
    void requiresAValueForEveryOperatorThatComparesOne() {
        RuleAction action = conditional(ActionType.IF_REQUEST,
                List.of(branch(condition(ConditionSubject.METHOD, null, ConditionOperator.EQUALS, null),
                        setHeader("X-A"))),
                null);

        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), action)))
                .anyMatch(problem -> problem.contains("needs a value to compare with"));
    }

    @Test
    void requiresANameForASubjectThatNeedsOneAndNotForOthers() {
        RuleAction noName = conditional(ActionType.IF_REQUEST,
                List.of(branch(condition(ConditionSubject.REQUEST_HEADER, null, ConditionOperator.EXISTS, null),
                        setHeader("X-A"))),
                null);
        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), noName)))
                .anyMatch(problem -> problem.contains("needs a name to look up"));

        RuleAction methodNeedsNone = conditional(ActionType.IF_REQUEST,
                List.of(branch(condition(ConditionSubject.METHOD, null, ConditionOperator.EQUALS, "GET"),
                        setHeader("X-A"))),
                null);
        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), methodNeedsNone))).isEmpty();
    }

    @Test
    void rejectsARegexThatDoesNotCompileAndAPathThatIsMalformed() {
        RuleAction badRegex = conditional(ActionType.IF_REQUEST,
                List.of(branch(condition(ConditionSubject.URL, null, ConditionOperator.MATCHES, "([unclosed"),
                        setHeader("X-A"))),
                null);
        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), badRegex)))
                .anyMatch(problem -> problem.contains("Condition regex does not compile"));

        RuleAction badPath = conditional(ActionType.IF_REQUEST,
                List.of(branch(condition(ConditionSubject.REQUEST_JSON_FIELD, "a..b",
                        ConditionOperator.EXISTS, null), setHeader("X-A"))),
                null);
        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), badPath)))
                .anyMatch(problem -> problem.contains("not a valid field path"));
    }

    @Test
    void rejectsANonNumberForANumericComparison() {
        RuleAction action = conditional(ActionType.IF_REQUEST,
                List.of(branch(condition(ConditionSubject.REQUEST_HEADER, "x-count",
                        ConditionOperator.AT_LEAST, "many"), setHeader("X-A"))),
                null);

        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), action)))
                .anyMatch(problem -> problem.contains("is not a number"));
    }

    @Test
    void allowsOneLevelOfNestingAndRefusesTwo() {
        Condition always = condition(ConditionSubject.METHOD, null, ConditionOperator.EQUALS, "GET");
        RuleAction depth2 = conditional(ActionType.IF_REQUEST,
                List.of(branch(always, setHeader("X-Deep"))), null);
        RuleAction depth1 = conditional(ActionType.IF_REQUEST, List.of(branch(always, depth2)), null);
        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), depth1))).isEmpty();

        RuleAction depth0 = conditional(ActionType.IF_REQUEST, List.of(branch(always, depth1)), null);
        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), depth0)))
                .anyMatch(problem -> problem.contains("nested"));
    }

    // ---- enabling and disabling one action ---------------------------------------------------

    private static RuleAction disabled(RuleAction action) {
        return new RuleAction(action.type(), action.durationMs(), action.name(), action.value(), action.path(),
                action.status(), action.headers(), action.body(), action.timeoutSeconds(), action.onTimeout(),
                action.failure(), action.branches(), action.otherwise(), false);
    }

    @Test
    void anActionBuiltTheOldWayIsEnabledByDefault() {
        // The shape before `enabled` existed - every rule saved before this feature, and every
        // one of the 24 call sites across this codebase that still build one positionally.
        assertThat(delay(5000).isEnabled()).isTrue();
    }

    @Test
    void disablingOneOfTwoConflictingTerminalsMakesTheRuleValid() {
        // The whole reason this exists: swap "mock the response" for "pause and edit it" without
        // deleting either one first.
        RuleAction abort = disabled(RuleAction.of(ActionType.ABORT_REQUEST));
        RuleAction mock = new RuleAction(ActionType.MOCK_RESPONSE, null, null, null, null, 500,
                Map.of(), "{}", null, null, null, null, null);

        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), abort, mock))).isEmpty();
    }

    @Test
    void disablingOneOfTwoConflictingTerminalsThatAreBothAlreadyDisabledStillPasses() {
        RuleAction abort = disabled(RuleAction.of(ActionType.ABORT_REQUEST));
        RuleAction mock = disabled(new RuleAction(ActionType.MOCK_RESPONSE, null, null, null, null, 500,
                Map.of(), "{}", null, null, null, null, null));

        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), abort, mock))).isEmpty();
    }

    @Test
    void twoEnabledTerminalsStillConflict() {
        // Disabling has to be the thing that resolves the contradiction, not merely having the
        // field present - the check must not accidentally stop firing altogether.
        RuleAction abort = RuleAction.of(ActionType.ABORT_REQUEST);
        RuleAction mock = new RuleAction(ActionType.MOCK_RESPONSE, null, null, null, null, 500,
                Map.of(), "{}", null, null, null, null, null);

        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), abort, mock)))
                .anyMatch(p -> p.contains("only end a request once"));
    }

    @Test
    void aDisabledPauseNoLongerConflictsWithATerminal() {
        RuleAction abort = RuleAction.of(ActionType.ABORT_REQUEST);
        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), abort, disabled(pause(30, "release")))))
                .isEmpty();
    }

    @Test
    void aDisabledActionIsStillValidatedOnItsOwnFields() {
        // It must be well-formed the moment somebody switches it back on - disabling is not an
        // escape hatch from validation, only from the engine actually running it.
        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), disabled(pause(0, "release")))))
                .anyMatch(p -> p.contains("hold its caller open forever"));
    }
}
