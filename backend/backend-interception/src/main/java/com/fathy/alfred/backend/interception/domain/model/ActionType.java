package com.fathy.alfred.backend.interception.domain.model;

/**
 * Every action the interception engine can carry out. The names are the wire format: they are
 * written verbatim into the rules snapshot and matched by string in proxy/interception.py's
 * REQUEST_ACTIONS/RESPONSE_ACTIONS sets, so renaming a constant here silently stops that action
 * firing. {@code InterceptionEngineContractTest} pins the two lists against each other.
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
    ABORT_REQUEST(Phase.REQUEST),
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
    PAUSE_RESPONSE(Phase.RESPONSE);

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
        return this == ABORT_REQUEST || this == MOCK_RESPONSE;
    }

    public boolean isPause() {
        return this == PAUSE_REQUEST || this == PAUSE_RESPONSE;
    }
}
