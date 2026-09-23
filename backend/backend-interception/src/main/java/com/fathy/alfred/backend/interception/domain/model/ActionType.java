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
     * Find and replace in the request body, any content type - the one edit that reaches a token in
     * a SOAP or plain-text body, where no JSON path can. Literal text unless {@code regex} is set.
     */
    REPLACE_IN_REQUEST_BODY(Phase.REQUEST),
    /**
     * Sends the call somewhere else: any of scheme/host/port/path (the structured form), or a
     * find/replace on the whole URL (the pattern form). Never to Alfred itself - see SelfTargets.
     */
    REWRITE_URL(Phase.REQUEST),
    /** Changes the HTTP method, keeping everything else - how a PUT against a POST-only endpoint is tested. */
    SET_METHOD(Phase.REQUEST),
    /**
     * Deletes a field outright - which is not the same as setting it to null, and "field missing"
     * is the more common supplier contract bug. Same path grammar as SET_REQUEST_JSON_FIELD.
     */
    REMOVE_REQUEST_JSON_FIELD(Phase.REQUEST),
    /** Replaces the whole outgoing request body, any content type - the counterpart of SET_RESPONSE_BODY. */
    SET_REQUEST_BODY(Phase.REQUEST),
    /**
     * Sets or removes ONE cookie on the Cookie header; every other cookie reaches the target byte
     * for byte. The value is never written into the interception record.
     */
    SET_REQUEST_COOKIE(Phase.REQUEST),
    REMOVE_REQUEST_COOKIE(Phase.REQUEST),
    /**
     * Sets or removes one field of a urlencoded or multipart form. A multipart file part is never
     * edited; any other body is recorded as "not a form".
     */
    SET_FORM_FIELD(Phase.REQUEST),
    REMOVE_FORM_FIELD(Phase.REQUEST),
    /** Removes If-None-Match and If-Modified-Since, so the full response comes back rather than a 304. */
    DISABLE_CACHE(Phase.REQUEST),
    /** Asks for an uncompressed response (Accept-Encoding: identity). */
    DISABLE_COMPRESSION(Phase.REQUEST),
    /**
     * Answers with a response recorded earlier - status, headers and body - and never contacts the
     * host. How yesterday's bug is reproduced today without the supplier's help.
     */
    ANSWER_WITH_RECORDED_CALL(Phase.REQUEST),
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
    /** The response-body counterpart of {@link #REPLACE_IN_REQUEST_BODY}. */
    REPLACE_IN_RESPONSE_BODY(Phase.RESPONSE),
    /** The response-body counterpart of {@link #REMOVE_REQUEST_JSON_FIELD}. */
    REMOVE_RESPONSE_JSON_FIELD(Phase.RESPONSE),
    /**
     * Sets one Set-Cookie line - replacing the one with the same cookie name, or adding one - with
     * the attributes in {@link CookieAttributes}; {@code maxAge = 0} expires it. Other Set-Cookie
     * lines are kept.
     */
    SET_RESPONSE_COOKIE(Phase.RESPONSE),
    REMOVE_RESPONSE_COOKIE(Phase.RESPONSE),
    /** Re-encodes the response body: decoded first, then compressed with the chosen encoding. */
    SET_RESPONSE_ENCODING(Phase.RESPONSE),
    /** Whole body, any content type - for a payload that isn't JSON or a change too structural for a field path. */
    SET_RESPONSE_BODY(Phase.RESPONSE),
    /**
     * The counterpart of MOCK_RESPONSE, and the difference is the point: MOCK_RESPONSE never opens
     * a connection, so the supplier never sees the call. This one lets the real request happen and
     * then hands the caller something else - the upstream call is real, logged and timed, while
     * the client under test sees whatever you need it to.
     */
    REPLACE_RESPONSE(Phase.RESPONSE),
    /**
     * The response-phase counterpart of {@link #ANSWER_WITH_RECORDED_CALL}: the host IS called and
     * its answer is then replaced by the recorded one, so the real call still shows up upstream.
     */
    REPLACE_WITH_RECORDED_RESPONSE(Phase.RESPONSE),
    PAUSE_RESPONSE(Phase.RESPONSE),
    /** The response-phase counterpart of {@link #IF_REQUEST}. */
    IF_RESPONSE(Phase.RESPONSE);

    /**
     * REQUEST and RESPONSE are the two halves of an HTTP exchange. MESSAGE is a WebSocket message
     * after the handshake - a third lane, because such an action runs once per message rather
     * than once per call, and has neither a request nor a response of its own to change.
     */
    public enum Phase { REQUEST, RESPONSE, MESSAGE }

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
        return this == ABORT_REQUEST || this == MOCK_RESPONSE || this == SIMULATE_FAILURE
                || this == ANSWER_WITH_RECORDED_CALL;
    }

    /** The kind of stored answer this action serves, or null for an action that uses none. */
    public StoredAnswer.Kind answerKind() {
        return switch (this) {
            case ANSWER_WITH_RECORDED_CALL, REPLACE_WITH_RECORDED_RESPONSE -> StoredAnswer.Kind.RECORDED;
            default -> null;
        };
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
