package com.fathy.alfred.backend.interception.domain.model;

/**
 * Every action the interception engine can carry out. The names are the wire format: they are
 * written verbatim into the rules snapshot and matched by string in proxy/interception.py's
 * REQUEST_ACTIONS/RESPONSE_ACTIONS sets, so renaming a constant here silently stops that action
 * firing. The proxy side has a test that walks its own sets and fails on an action with no
 * coverage ({@code EveryActionIsCoveredTest}); nothing can pin the two languages against each
 * other in one place, so adding an action means editing both - see docs/interception.md.
 *
 * <p>The phase split is not cosmetic. A request action has no response to work on, and a response
 * action has nothing left to change about a request that has already been sent, so applying one in
 * the wrong phase can only ever be a no-op - which is why the engine skips rather than errors, and
 * why validation rejects it up front instead of letting a user save a rule that will never fire.
 */
public enum ActionType {

    DELAY_REQUEST(Phase.REQUEST),
    SET_REQUEST_HEADER(Phase.REQUEST),
    REMOVE_REQUEST_HEADER(Phase.REQUEST),
    SET_QUERY_PARAM(Phase.REQUEST),
    REMOVE_QUERY_PARAM(Phase.REQUEST),
    SET_REQUEST_JSON_FIELD(Phase.REQUEST),
    /**
     * Kept for rules saved before {@link #SIMULATE_FAILURE} existed, and hidden from the editor's
     * picker - it is exactly {@code SIMULATE_FAILURE} with {@link FailureMode#CONNECTION_RESET}.
     * Still evaluated, because a stored rule must not stop working when the UI moves on.
     */
    ABORT_REQUEST(Phase.REQUEST),
    /**
     * Everything a supplier does that is not an HTTP status: resets, hangs, empty and truncated
     * replies. One action with a {@link FailureMode} rather than one action per failure, because
     * they are alternatives - you pick what goes wrong, you do not compose them.
     */
    SIMULATE_FAILURE(Phase.REQUEST),
    MOCK_RESPONSE(Phase.REQUEST),
    PAUSE_REQUEST(Phase.REQUEST),
    /**
     * "Actually call the real thing." Forwarding is the default, so on its own this states intent
     * and makes a rule read as a pipeline - send, then handle what comes back. What makes it more
     * than documentation is that it LATCHES: a MOCK_RESPONSE or ABORT_REQUEST from any later rule
     * is refused for that call, which is how a narrow exception is expressed against a broad
     * mocking rule without carving a hole in the broad rule itself.
     */
    SEND_TO_HOST(Phase.REQUEST),
    /**
     * Look at the call, then decide. Branches are tried in order and the first match wins; what a
     * branch may contain is any action of this same phase, including a terminal or a pause.
     *
     * <p>Two types rather than one with a phase field, so phase stays derivable from the name the
     * way every other action's is - which is what lets the editor sort actions into lanes and the
     * engine skip the wrong half without a special case.
     */
    IF_REQUEST(Phase.REQUEST),

    DELAY_RESPONSE(Phase.RESPONSE),
    SET_RESPONSE_STATUS(Phase.RESPONSE),
    SET_RESPONSE_HEADER(Phase.RESPONSE),
    REMOVE_RESPONSE_HEADER(Phase.RESPONSE),
    SET_RESPONSE_JSON_FIELD(Phase.RESPONSE),
    /** Whole body, any content type - for a payload that isn't JSON or a change too structural for a field path. */
    SET_RESPONSE_BODY(Phase.RESPONSE),
    /**
     * The counterpart of MOCK_RESPONSE, and the difference is the point: MOCK_RESPONSE never opens
     * a connection, so the supplier never sees the call. This one lets the real request happen and
     * then hands the caller something else - the upstream call is real, logged and timed, while
     * the client under test sees whatever you need it to.
     */
    REPLACE_RESPONSE(Phase.RESPONSE),
    PAUSE_RESPONSE(Phase.RESPONSE),
    /** The response-phase counterpart of {@link #IF_REQUEST}. */
    IF_RESPONSE(Phase.RESPONSE);

    public enum Phase { REQUEST, RESPONSE }

    private final Phase phase;

    ActionType(Phase phase) {
        this.phase = phase;
    }

    public Phase phase() {
        return phase;
    }

    /**
     * An action after which there is no upstream request left to modify. The engine stops the
     * request phase on one of these; two of them in a single rule is a contradiction the user
     * should be told about rather than have silently resolved by ordering.
     */
    public boolean isTerminal() {
        return this == ABORT_REQUEST || this == MOCK_RESPONSE || this == SIMULATE_FAILURE;
    }

    /**
     * Whether the editor offers this action. ABORT_REQUEST is still evaluated for rules that
     * already use it, but a user building a new rule reaches it through SIMULATE_FAILURE instead
     * of choosing between two actions that do the same thing.
     */
    public boolean isSelectable() {
        return this != ABORT_REQUEST;
    }

    public boolean isPause() {
        return this == PAUSE_REQUEST || this == PAUSE_RESPONSE;
    }

    public boolean isConditional() {
        return this == IF_REQUEST || this == IF_RESPONSE;
    }
}
