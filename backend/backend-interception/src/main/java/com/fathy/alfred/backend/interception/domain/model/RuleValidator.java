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

    /**
     * What some actions are checked against beyond their own fields - looked up once per rule and
     * handed down through every nested branch, so a condition's inner actions are held to exactly
     * the same checks as top-level ones.
     */
    private record Checks(SelfTargets selfTargets) {
    }

    /** Two levels: a condition, and a condition inside one of its branches. See validateConditional. */
    private static final int MAX_CONDITION_DEPTH = 2;

    /** Enough for if / else-if / else-if / else-if; past that it is a lookup table, not a rule. */
    private static final int MAX_BRANCHES = 8;

    public static List<String> validate(InterceptionRule rule) {
        return validate(rule, SelfTargets.none());
    }

    /**
     * @param selfTargets where a REWRITE_URL may not point: Alfred's own services and listeners.
     *                    The proxy re-checks a pattern rewrite at run time, since its result is
     *                    only known then.
     */
    public static List<String> validate(InterceptionRule rule, SelfTargets selfTargets) {
        Checks checks = new Checks(selfTargets == null ? SelfTargets.none() : selfTargets);
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
            // Structural checks below count only what actually runs. A disabled action is still
            // validated on its own fields - it must be well-formed for the moment it is switched
            // back on - but it takes no part in "can this rule contradict itself", or disabling
            // one of two conflicting terminals to try the other would still be refused for a
            // conflict that, with one of them off, no longer exists.
            if (action.isEnabled()) {
                if (action.type().isTerminal()) {
                    terminals++;
                }
                if (action.type().isPause()) {
                    pauses++;
                }
                if (action.type() == ActionType.SEND_TO_HOST) {
                    sendsToHost = true;
                }
            }
            validateAction(action, problems, checks);
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

    private static void validateAction(RuleAction action, List<String> problems, Checks checks) {
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
            case REMOVE_REQUEST_JSON_FIELD, REMOVE_RESPONSE_JSON_FIELD -> {
                if (action.path() == null || action.path().isBlank()) {
                    problems.add(action.type() + " needs a field path, e.g. segments[*].cabin.");
                } else if (!isValidPath(action.path())) {
                    problems.add("\"" + action.path() + "\" is not a valid field path.");
                } else if (action.path().strip().endsWith("[*]")) {
                    // `items[*]` would mean "remove every element" - an empty array, not a removed
                    // field. Say which one you mean: remove `items`, or set it to [].
                    problems.add(action.type() + " cannot end in [*]. Remove the array itself, or set it to [] with Set JSON field.");
                }
            }
            case SET_REQUEST_BODY -> {
                if (action.body() == null) {
                    problems.add("SET_REQUEST_BODY needs a body - use an empty string to send none.");
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
            case IF_REQUEST, IF_RESPONSE -> validateConditional(action, problems, 1, checks);
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
            case REPLACE_IN_REQUEST_BODY, REPLACE_IN_RESPONSE_BODY -> validateReplacement(action, problems);
            case REWRITE_URL -> validateRewrite(action, problems, checks.selfTargets());
            case SET_METHOD -> {
                if (action.method() == null || !action.method().strip().matches("[A-Za-z]+")) {
                    problems.add("SET_METHOD needs a method made of letters only, such as PUT.");
                }
            }
            // Deliberately not exhaustive-by-omission: a new ActionType with no case here would
            // otherwise be saved with no validation at all, and fail only once it reached the proxy.
            default -> problems.add("Unknown action type " + action.type() + ".");
        }
    }


    private static void validateRewrite(RuleAction action, List<String> problems, SelfTargets selfTargets) {
        UrlTarget target = action.target();
        boolean structured = target != null && !target.isEmpty();
        if (!structured && action.pattern() == null) {
            problems.add("REWRITE_URL needs a target (scheme, host, port or path) or a pattern to apply to the URL.");
            return;
        }
        if (structured) {
            if (target.scheme() != null && !target.scheme().isBlank()
                    && !target.scheme().equals("http") && !target.scheme().equals("https")) {
                problems.add("REWRITE_URL can only switch between http and https.");
            }
            if (target.port() != null && (target.port() < 1 || target.port() > 65_535)) {
                problems.add("REWRITE_URL needs a port between 1 and 65535.");
            }
            if (target.path() != null && !target.path().isBlank() && !target.path().startsWith("/")) {
                problems.add("REWRITE_URL's path must start with /.");
            }
            if (target.host() != null && !target.host().isBlank()
                    && selfTargets.includes(target.host(), target.port())) {
                problems.add("REWRITE_URL cannot send a call to Alfred itself (" + target.host()
                        + (target.port() != null ? ":" + target.port() : "") + ") - it would loop through the proxy.");
            }
        } else {
            validateReplacement(action, problems);
        }
    }

    /**
     * Everything a find/replace needs, shared by every action that finds text. The pattern checks
     * are PatternSafety's; this only adds what is specific to replacing.
     */
    private static void validateReplacement(RuleAction action, List<String> problems) {
        boolean regex = Boolean.TRUE.equals(action.regex());
        for (String problem : PatternSafety.problems(action.pattern(), regex)) {
            problems.add(action.type() + ": " + problem);
        }
        if (action.replacement() == null) {
            problems.add(action.type() + " needs a replacement - an empty one deletes what it finds.");
        }
        if (action.maxReplacements() != null && (action.maxReplacements() < 1 || action.maxReplacements() > 10_000)) {
            problems.add(action.type() + " may replace between 1 and 10,000 matches, or leave the limit empty for all of them.");
        }
    }

    /**
     * A conditional and everything inside it.
     *
     * <p>{@code depth} exists to stop a rule nesting itself out of readability. The engine would
     * happily evaluate a condition inside a condition inside a condition; a human trying to work
     * out why a booking failed would not, and this feature changes production-shaped traffic.
     */
    private static void validateConditional(RuleAction action, List<String> problems, int depth, Checks checks) {
        if (depth > MAX_CONDITION_DEPTH) {
            problems.add("Conditions may be nested " + MAX_CONDITION_DEPTH + " deep at most - past "
                    + "that a rule cannot be read at a glance, which is worse than not expressing it.");
            return;
        }

        List<ConditionBranch> branches = action.branches() == null ? List.of() : action.branches();
        if (branches.isEmpty()) {
            problems.add(action.type() + " needs at least one IF branch.");
        }
        if (branches.size() > MAX_BRANCHES) {
            problems.add("A condition may have at most " + MAX_BRANCHES + " branches.");
        }

        boolean wantsResponse = action.type() == ActionType.IF_RESPONSE;
        for (ConditionBranch branch : branches) {
            if (branch.conditions().isEmpty()) {
                problems.add("An IF branch with no conditions always matches - give it a condition, "
                        + "or move its actions to the ELSE.");
            }
            for (Condition condition : branch.conditions()) {
                validateCondition(condition, wantsResponse, problems);
            }
            if (branch.actions().isEmpty()) {
                problems.add("An IF branch that does nothing when it matches has no effect - remove it.");
            }
            validateNestedActions(branch.actions(), action.type(), problems, depth, checks);
        }
        if (action.otherwise() != null) {
            validateNestedActions(action.otherwise(), action.type(), problems, depth, checks);
        }
    }

    /**
     * Actions inside a branch. They must belong to the conditional's own phase: a response action
     * inside an IF_REQUEST has nothing to act on and could only ever be a no-op, which is worth
     * refusing at save time rather than leaving someone to wonder why their rule did nothing.
     *
     * <p>Terminals are NOT counted against the rule's one-ending limit here. Two branches are
     * alternatives - only one ever runs - so a rule that mocks in one arm and aborts in another is
     * perfectly coherent, where two terminals in a row would be a contradiction.
     */
    private static void validateNestedActions(List<RuleAction> actions, ActionType parent,
                                              List<String> problems, int depth, Checks checks) {
        ActionType.Phase phase = parent.phase();
        for (RuleAction nested : actions) {
            if (nested.type() == null) {
                problems.add("Every action needs a type.");
                continue;
            }
            if (nested.type().phase() != phase) {
                problems.add(nested.type() + " is a " + nested.type().phase().name().toLowerCase()
                        + "-phase action, so it cannot go inside " + parent + ".");
                continue;
            }
            if (nested.type().isConditional()) {
                validateConditional(nested, problems, depth + 1, checks);
            } else {
                validateAction(nested, problems, checks);
            }
        }
    }

    private static void validateCondition(Condition condition, boolean responsePhase, List<String> problems) {
        if (condition.subject() == null) {
            problems.add("A condition needs something to look at.");
            return;
        }
        if (condition.operator() == null) {
            problems.add("A condition on " + condition.subject() + " needs a comparison.");
            return;
        }
        if (condition.subject().isResponse() && !responsePhase) {
            problems.add(condition.subject() + " cannot be checked before the response exists - "
                    + "put this condition in the response half of the rule.");
        }
        if (condition.subject().needsName() && (condition.name() == null || condition.name().isBlank())) {
            problems.add(condition.subject() + " needs a name to look up.");
        }
        if ((condition.subject() == ConditionSubject.REQUEST_JSON_FIELD
                || condition.subject() == ConditionSubject.RESPONSE_JSON_FIELD)
                && condition.name() != null && !condition.name().isBlank()
                && !isValidPath(condition.name())) {
            problems.add("\"" + condition.name() + "\" is not a valid field path.");
        }
        if (condition.operator().needsValue() && (condition.value() == null || condition.value().isEmpty())) {
            problems.add(condition.subject() + " " + condition.operator() + " needs a value to compare with.");
            return;
        }
        if (condition.operator().isRegex()) {
            try {
                Pattern.compile(condition.value());
            } catch (PatternSyntaxException e) {
                problems.add("Condition regex does not compile: " + e.getDescription() + ".");
            }
        }
        if (condition.operator().isNumeric()) {
            try {
                Double.parseDouble(condition.value());
            } catch (NumberFormatException e) {
                problems.add("\"" + condition.value() + "\" is not a number, so " + condition.operator()
                        + " cannot compare against it.");
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
