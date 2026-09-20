package com.fathy.alfred.backend.interception.application.port.in;

import com.fathy.alfred.backend.interception.domain.model.PauseDecision;
import com.fathy.alfred.backend.interception.domain.model.PausedCall;

import java.util.List;
import java.util.Optional;

/**
 * The handoff between a proxy holding a caller's connection open and a human looking at a screen.
 *
 * <p>Three parties touch one paused call: the proxy registers it and then waits for a decision,
 * the frontend lists it and eventually decides, and a timer resolves it if nobody does. The last
 * of those is not optional - a paused call nobody answers would hold a real client socket open
 * forever.
 */
public interface BreakpointUseCase {

    /** Called by the proxy the moment it pauses a flow. */
    void register(PausedCall call);

    List<PausedCall> pending();

    /**
     * The proxy's long poll. Blocks up to {@code waitMs} for a decision and returns empty if none
     * arrived, so the caller can poll again and notice a backend that has gone away rather than
     * hanging on one very long request.
     */
    Optional<PauseDecision> awaitDecision(String callId, long waitMs) throws InterruptedException;

    /**
     * Whether this call is still waiting on a decision.
     *
     * Exists so the long poll can distinguish "nothing decided yet, ask again" from "this call is
     * over, stop asking". Without that distinction {@link #awaitDecision} answers an unknown call
     * instantly, and a polling proxy with no rate floor turns that into a maximum-rate request
     * loop - measured at 60% CPU in the proxy and 35% in the backend, from ONE call.
     */
    boolean isWaiting(String callId);

    /** The user's decision from the inspector. False when that call is no longer waiting. */
    boolean decide(String callId, PauseDecision decision);

    /**
     * Stops the countdown on a paused call and holds it until an explicit decision.
     *
     * The timeout is a grace period for somebody to NOTICE, not a deadline for deciding: once a
     * human is demonstrably at the screen, expiring the call out from under them mid-edit is the
     * one behaviour that makes editing a large body impossible. Returns false when that call is no
     * longer waiting.
     */
    boolean takeControl(String callId);

    /** Releases everything currently paused, unchanged - the inspector's "release all" and the panic button. */
    int releaseAll();

    /**
     * The proxy telling us it has stopped waiting (decision applied, or its own timeout fired).
     *
     * <p>Only drops a row that is still HOLDING. This is posted after every decision, including
     * one that moved the call on to in-flight, and dropping the row then would undo the whole
     * point of following it through its cycle.
     */
    void resolved(String callId);

    /**
     * The proxy reporting the end of a followed call's cycle - the answer it delivered, or why
     * there wasn't one. Does nothing for a call nobody is following, which is the common case.
     *
     * @param outcome "completed", "aborted", "failed" or "never-came-back"
     * @param note    free text for an outcome that needs one, such as the error that killed it
     */
    void completed(String callId, PausedCall.Http response, String outcome, String note);

    /**
     * Dismisses a finished or in-flight card. Refuses while the call still holds its caller:
     * dismissing that would orphan a real socket with no way back to it.
     */
    boolean close(String callId);

    /** Dismisses every finished card at once. */
    int closeFinished();
}
