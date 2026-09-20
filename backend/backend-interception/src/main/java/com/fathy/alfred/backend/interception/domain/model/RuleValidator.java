package com.fathy.alfred.backend.interception.domain.model;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

/**
 * Rejects a rule the engine could not carry out, before it is ever written.
 *
 * <p>This lives in the domain rather than as Bean Validation annotations on the DTO because most
 * of it is conditional on {@code type}: a {@code durationMs} is required for DELAY_REQUEST and
 * meaningless for ABORT_REQUEST, which is not something an annotation on one field can express.
 * Bean Validation still guards the outer shape (see InterceptionRuleRequestDto).
 *
 * <p>It is also the last place a bad regex can be caught cheaply. The proxy compiles every
 * {@code pathRegex} once at rule-load time and skips a rule whose pattern will not compile - which
 * is the right failure there, but a silent one. Failing here means the user finds out while they
 * are looking at the rule, not by wondering why it never fires.
 */
public final class RuleValidator {

    /** Mirrors proxy/interception.py's MAX_DELAY_MS. A delay is the one action that can hold a socket open by typo. */
    public static final int MAX_DELAY_MS = 120_000;
    /** Mirrors proxy/interception.py's MAX_PAUSE_SECONDS. */
    public static final int MAX_PAUSE_SECONDS = 300;
    public static final int MAX_ACTIONS_PER_RULE = 20;

    private RuleValidator() {
    }

    public static List<String> validate(InterceptionRule rule) {
        List<String> problems = new ArrayList<>();

        if (rule.name() == null || rule.name().isBlank()) {
            problems.add("A rule needs a name.");
        } else if (rule.name().length() > 120) {
            problems.add("Rule name must be 120 characters or fewer.");
        }
        if (rule.actions().isEmpty()) {
            problems.add("A rule needs at least one action, or it would match traffic and do nothing.");
        }
        if (rule.actions().size() > MAX_ACTIONS_PER_RULE) {
            problems.add("A rule may have at most " + MAX_ACTIONS_PER_RULE + " actions.");
        }

        validateMatch(rule.match(), problems);

        int terminals = 0;
        int pauses = 0;
        boolean sendsToHost = false;
        for (RuleAction action : rule.actions()) {
            if (action.type() == null) {
                problems.add("Every action needs a type.");
                continue;
            }
            if (action.type().isTerminal()) {
                terminals++;
            }
            if (action.type().isPause()) {
                pauses++;
            }
            if (action.type() == ActionType.SEND_TO_HOST) {
                sendsToHost = true;
            }
            validateAction(action, problems);
        }

        if (terminals > 1) {
            problems.add("A rule can only end a request once - keep one of mocking it, failing it, "
                    + "or aborting it.");
        }
        if (pauses > 1) {
            problems.add("A rule can only pause a call once.");
        }
        if (sendsToHost && terminals > 0) {
            problems.add("This rule both sends the call to the host and short-circuits it - keep one.");
        }
        if (terminals > 0 && pauses > 0) {
            problems.add("A rule that aborts or mocks a request never reaches a pause - remove one of them.");
        }
        return problems;
    }

    private static void validateMatch(RuleMatch match, List<String> problems) {
        if (match.source() != null && !match.source().isBlank()
                && !List.of("outbound", "inbound", "both").contains(match.source())) {
            problems.add("Direction must be outbound, inbound or both.");
        }
        for (String name : match.serviceNames()) {
            if (name == null || name.isBlank()) {
                problems.add("A project name cannot be blank - leave the field empty to match any project.");
            }
        }
        for (String method : match.methods()) {
            if (method == null || method.isBlank() || !method.chars().allMatch(Character::isLetter)) {
                problems.add("\"" + method + "\" is not an HTTP method.");
            }
        }
        if (match.pathRegex() != null && !match.pathRegex().isBlank()) {
            try {
                Pattern.compile(match.pathRegex());
            } catch (PatternSyntaxException e) {
                problems.add("Path regex does not compile: " + e.getDescription() + ".");
            }
        }
    }

    private static void validateAction(RuleAction action, List<String> problems) {
        switch (action.type()) {
            case DELAY_REQUEST, DELAY_RESPONSE -> {
                if (action.durationMs() == null || action.durationMs() < 0) {
                    problems.add(action.type() + " needs a duration of 0 ms or more.");
                } else if (action.durationMs() > MAX_DELAY_MS) {
                    problems.add(action.type() + " is capped at " + MAX_DELAY_MS + " ms.");
                }
            }
            case SET_REQUEST_HEADER, SET_RESPONSE_HEADER -> {
                requireName(action, problems);
                if (action.value() == null) {
                    problems.add(action.type() + " needs a value.");
                }
            }
            case REMOVE_REQUEST_HEADER, REMOVE_RESPONSE_HEADER, REMOVE_QUERY_PARAM -> requireName(action, problems);
            case SET_QUERY_PARAM -> {
                requireName(action, problems);
                if (action.value() == null) {
                    problems.add("SET_QUERY_PARAM needs a value.");
                }
            }
            case SET_REQUEST_JSON_FIELD, SET_RESPONSE_JSON_FIELD -> {
                if (action.path() == null || action.path().isBlank()) {
                    problems.add(action.type() + " needs a field path, e.g. itinerary.seatsRemaining.");
                } else if (!isValidPath(action.path())) {
                    problems.add("\"" + action.path() + "\" is not a valid field path.");
                }
            }
            case SET_RESPONSE_STATUS -> requireStatus(action, problems);
            case SET_RESPONSE_BODY -> {
                if (action.body() == null) {
                    problems.add("SET_RESPONSE_BODY needs a body - use an empty string to blank the response.");
                }
            }
            case REPLACE_RESPONSE -> {
                // Every part is optional on its own; an omitted one means "keep what upstream sent".
                // All three omitted would be a no-op, which is worth saying rather than saving.
                if (action.status() == null && action.headers() == null && action.body() == null) {
                    problems.add("REPLACE_RESPONSE needs at least a status, a header or a body to replace.");
                }
                if (action.status() != null && (action.status() < 100 || action.status() > 599)) {
                    problems.add("REPLACE_RESPONSE needs a status code between 100 and 599.");
                }
            }
            case MOCK_RESPONSE -> requireStatus(action, problems);
            case PAUSE_REQUEST, PAUSE_RESPONSE -> {
                if (action.timeoutSeconds() == null || action.timeoutSeconds() < 1) {
                    problems.add(action.type() + " needs a timeout of at least 1 second - a paused call with no "
                            + "timeout would hold its caller open forever.");
                } else if (action.timeoutSeconds() > MAX_PAUSE_SECONDS) {
                    problems.add("A call may be paused for at most " + MAX_PAUSE_SECONDS + " seconds.");
                }
                if (action.onTimeout() != null && !List.of("release", "abort").contains(action.onTimeout())) {
                    problems.add("On timeout must be release or abort.");
                }
            }
            case SIMULATE_FAILURE -> {
                if (action.failure() == null || action.failure().isBlank()) {
                    problems.add("SIMULATE_FAILURE needs to say what goes wrong.");
                } else if (!FailureMode.isKnown(action.failure())) {
                    problems.add("\"" + action.failure() + "\" is not a failure Alfred can reproduce.");
                } else {
                    switch (FailureMode.valueOf(action.failure())) {
                        case HANG_THEN_DROP -> {
                            if (action.durationMs() == null || action.durationMs() < 0) {
                                problems.add("Hanging then dropping needs a duration of 0 ms or more.");
                            } else if (action.durationMs() > MAX_DELAY_MS) {
                                problems.add("Hanging is capped at " + MAX_DELAY_MS + " ms - use "
                                        + "\"hang until the caller gives up\" to hold one longer.");
                            }
                        }
                        // The point of it is that the CALLER's timeout is what ends the call, so a
                        // status or body would never be sent and a duration is not ours to set.
                        case GATEWAY_ERROR -> {
                            if (action.status() == null || !List.of(502, 503, 504).contains(action.status())) {
                                problems.add("A gateway failure is 502, 503 or 504 - anything else is a "
                                        + "response the supplier sent, so use Mock response for it.");
                            }
                        }
                        case TRUNCATED_BODY -> {
                            if (action.body() == null || action.body().isEmpty()) {
                                problems.add("Truncating needs a body to cut short - an empty one is "
                                        + "\"empty reply\" instead.");
                            }
                        }
                        default -> {
                            // CONNECTION_RESET, HANG_UNTIL_CALLER_GIVES_UP and EMPTY_REPLY take nothing.
                        }
                    }
                }
            }
            case ABORT_REQUEST, SEND_TO_HOST -> {
                // Neither takes any parameters.
            }
        }
    }

    private static void requireName(RuleAction action, List<String> problems) {
        if (action.name() == null || action.name().isBlank()) {
            problems.add(action.type() + " needs a name.");
        }
    }

    private static void requireStatus(RuleAction action, List<String> problems) {
        if (action.status() == null || action.status() < 100 || action.status() > 599) {
            problems.add(action.type() + " needs a status code between 100 and 599.");
        }
    }

    /**
     * The same dotted-path subset proxy/interception.py's _parse_path accepts: dotted segments,
     * {@code [0]} indexes, {@code [*]} for every element. Kept in step with that function by
     * {@code RuleValidatorTest}, which runs the same corpus of paths this accepts.
     */
    static boolean isValidPath(String path) {
        if (path.startsWith(".") || path.endsWith(".") || path.contains("..")) {
            return false;
        }
        for (String part : path.split("\\.", -1)) {
            if (part.isBlank()) {
                return false;
            }
            int bracket = part.indexOf('[');
            String name = bracket < 0 ? part : part.substring(0, bracket);
            if (bracket == 0) {
                return false;
            }
            if (!name.isEmpty() && name.indexOf(']') >= 0) {
                return false;
            }
            if (bracket >= 0) {
                String rest = part.substring(bracket);
                if (!rest.matches("(\\[(\\*|-?\\d+)])+")) {
                    return false;
                }
            }
        }
        return true;
    }
}
