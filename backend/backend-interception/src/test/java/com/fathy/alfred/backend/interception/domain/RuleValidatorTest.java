package com.fathy.alfred.backend.interception.domain;

import com.fathy.alfred.backend.interception.domain.model.ActionType;
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
        return new RuleAction(ActionType.DELAY_REQUEST, ms, null, null, null, null, null, null, null, null, null);
    }

    private static RuleAction pause(int seconds, String onTimeout) {
        return new RuleAction(ActionType.PAUSE_RESPONSE, null, null, null, null, null, null, null, seconds, onTimeout, null);
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
                Map.of(), "{}", null, null, null);
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
                null, "{\"error\":\"nope\"}", null, null, null);
        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), send, replace))).isEmpty();
    }

    @Test
    void rejectsARuleThatBothSendsToTheHostAndShortCircuits() {
        RuleAction send = RuleAction.of(ActionType.SEND_TO_HOST);
        RuleAction mock = new RuleAction(ActionType.MOCK_RESPONSE, null, null, null, null, 500,
                Map.of(), "{}", null, null, null);
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
                null, null, null, null, null);
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
                null, "", null, null, null);
        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), blank))).isEmpty();
    }

    @Test
    void rejectsAHeaderActionWithNoName() {
        RuleAction action = new RuleAction(ActionType.SET_REQUEST_HEADER, null, " ", "v", null, null, null, null, null, null, null);
        assertThat(RuleValidator.validate(rule(RuleMatch.empty(), action))).anyMatch(p -> p.contains("needs a name"));
    }

    @Test
    void rejectsAStatusOutsideTheHttpRange() {
        RuleAction action = new RuleAction(ActionType.SET_RESPONSE_STATUS, null, null, null, null, 42,
                null, null, null, null, null);
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
                    null, null, null, null, null, null);
            assertThat(RuleValidator.validate(rule(RuleMatch.empty(), action)))
                    .as("path %s", path)
                    .isEmpty();
        }
    }

    private static RuleAction failure(String mode, Integer durationMs, Integer status, String body) {
        return new RuleAction(ActionType.SIMULATE_FAILURE, durationMs, null, null, null, status,
                null, body, null, null, mode);
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
                null, null, null, null, null);

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
                    null, null, null, null, null, null);
            assertThat(RuleValidator.validate(rule(RuleMatch.empty(), action)))
                    .as("path %s", path)
                    .isNotEmpty();
        }
    }
}
