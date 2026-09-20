package com.fathy.alfred.backend.interception.application.service;

import com.fathy.alfred.backend.interception.application.port.in.BreakpointUseCase;
import com.fathy.alfred.backend.interception.application.port.out.InterceptionNotificationPort;
import com.fathy.alfred.backend.interception.domain.model.PauseDecision;
import com.fathy.alfred.backend.interception.domain.model.PauseStage;
import com.fathy.alfred.backend.interception.domain.model.PausedCall;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.TimeUnit;

/**
 * The registry of calls currently held at the proxy, and the rendezvous between the proxy thread
 * waiting for a decision and the HTTP request carrying one.
 *
 * <p>In-memory on purpose, and it is worth being explicit about why, because "shouldn't this be in
 * the database like everything else" is the obvious question. A paused call is a live socket on a
 * machine that is still running. Recovering one from disk after a restart would offer a decision
 * about traffic whose caller timed out long ago, and the proxy on the other side has already given
 * up and applied its own timeout action. Losing the registry on restart is therefore not data loss
 * - it is the only correct behaviour.
 *
 * <p>The rendezvous is a {@link SynchronousQueue} per paused call rather than a
 * shared-map-plus-polling arrangement: the proxy's long poll parks on {@code poll(timeout)} and is
 * handed the decision directly by whichever thread produced it, so a release is delivered in
 * microseconds instead of on the next poll tick. {@code offer} is non-blocking, so a decision
 * arriving for a call whose proxy has already walked away cannot wedge the HTTP thread that
 * delivered it.
 */
@Service
public class BreakpointService implements BreakpointUseCase {

    private static final Logger log = LoggerFactory.getLogger(BreakpointService.class);

    /**
     * The backstop on a held call. "Until you decide" is what the user asked for and what this
     * implements - but a browser tab closed on a held call would otherwise pin a real client
     * socket open with nobody left to answer it, so there is an outer limit. It is deliberately
     * far beyond any interactive session (an hour) rather than a number anyone will hit while
     * working, and the UI states it.
     */
    private static final long MAX_HELD_MS =
            Long.getLong("alfred.interception.max-held-ms", 60L * 60L * 1000L);

    /**
     * How many finished cards are kept before the oldest starts falling off. Generous enough to
     * follow a whole debugging session, small enough that a tab left open overnight is not a slow
     * memory leak of whole request and response bodies.
     */
    private static final int MAX_FINISHED_CARDS = 20;

    private final InterceptionNotificationPort notifications;

    private final Map<String, PausedCall> paused = new ConcurrentHashMap<>();
    private final Map<String, SynchronousQueue<PauseDecision>> handoffs = new ConcurrentHashMap<>();

    public BreakpointService(InterceptionNotificationPort notifications) {
        this.notifications = notifications;
    }

    @Override
    public void register(PausedCall call) {
        // A followed call comes back here for its response half. Everything learned on the way -
        // that it was followed, when it was released, what was edited into the request - lives on
        // the existing entry, and overwriting it wholesale would lose the first half of the very
        // cycle the user asked to see.
        PausedCall existing = paused.get(call.callId());
        PausedCall arriving = existing == null ? call : call.at(PauseStage.HOLDING, existing.cycle());
        paused.put(call.callId(), arriving);
        handoffs.put(call.callId(), new SynchronousQueue<>());
        log.info("Call {} paused by rule '{}' ({}), holding its caller for up to {}s",
                call.callId(), call.ruleName(), call.phase(), call.timeoutSeconds());
        notifications.pausedCallsChanged();
    }

    @Override
    public List<PausedCall> pending() {
        List<PausedCall> calls = new ArrayList<>(paused.values());
        // Holding first - those are the ones with somebody on the other end - then in flight, then
        // finished. Within the two live stages, oldest first: the one closest to timing out needs
        // a decision soonest. Finished cards go newest first, because the one you just released is
        // the one you are about to read.
        calls.sort(Comparator
                .comparingInt((PausedCall call) -> call.stage().ordinal())
                .thenComparing(call -> call.stage() == PauseStage.FINISHED ? -call.pausedAt() : call.pausedAt()));
        return calls;
    }

    @Override
    public boolean isWaiting(String callId) {
        return handoffs.containsKey(callId);
    }

    @Override
    public Optional<PauseDecision> awaitDecision(String callId, long waitMs) throws InterruptedException {
        SynchronousQueue<PauseDecision> handoff = handoffs.get(callId);
        if (handoff == null) {
            // Answering "nothing yet" here is what caused a machine-wide freeze: the caller cannot
            // tell it apart from a quiet poll window, so it re-asks immediately, forever. The
            // controller checks isWaiting first and answers 404 instead; this stays defensive for
            // the race where the call is resolved between that check and this line.
            return Optional.empty();
        }
        return Optional.ofNullable(handoff.poll(waitMs, TimeUnit.MILLISECONDS));
    }

    @Override
    public boolean takeControl(String callId) {
        PausedCall call = paused.get(callId);
        if (call == null || call.isHeld()) {
            return call != null;
        }
        paused.put(callId, call.heldNow(System.currentTimeMillis()));

        // Handed to the waiting proxy straight away rather than waiting for its next poll: until
        // the proxy knows, it is still counting down against its own deadline, and the gap is
        // exactly where a call would be released while somebody was typing into it.
        SynchronousQueue<PauseDecision> handoff = handoffs.get(callId);
        if (handoff != null) {
            handoff.offer(PauseDecision.hold());
        }
        log.info("Call {} taken under manual control - its countdown is stopped", callId);
        notifications.pausedCallsChanged();
        return true;
    }

    @Override
    public boolean decide(String callId, PauseDecision decision) {
        SynchronousQueue<PauseDecision> handoff = handoffs.get(callId);
        if (handoff == null) {
            return false;
        }
        PausedCall before = paused.get(callId);
        // Moved on BEFORE the decision is handed over, and that order matters. The proxy posts
        // /resolved the instant it stops waiting, on another thread; if this row were still
        // HOLDING when that landed, resolved() would delete the very card we are turning into a
        // followed one. Advancing first means the row is already past HOLDING by then.
        advance(callId, decision);

        // Non-blocking: if the proxy is between polls there is no consumer parked on the queue
        // right now, so this would block an HTTP worker thread for the whole poll gap.
        boolean handed = handoff.offer(decision);
        if (handed) {
            handoffs.remove(callId);
            notifications.pausedCallsChanged();
            return true;
        }
        // Nobody was listening, so the decision never left this machine. Put the row back exactly
        // as it was rather than leaving a card claiming a release that never happened - the proxy
        // will find the call gone on its next poll and fall back to its timeout action.
        if (before == null) {
            paused.remove(callId);
        } else {
            paused.put(callId, before);
        }
        return false;
    }

    /**
     * What becomes of the card once a decision has gone out.
     *
     * <p>Until this existed, every decision deleted the row, so a request breakpoint vanished the
     * instant you pressed Send and you never saw what came back. A call a human decided on is now
     * followed to the end of its cycle instead - in flight while the supplier works, finished when
     * the answer is in, and closed by hand.
     *
     * <p>A decision nobody made is the exception and still deletes the row. A rule that pauses
     * everything times out dozens of calls on busy traffic; a card for each of those would bury
     * the one call you are actually working on under the ones you never saw.
     */
    private void advance(String callId, PauseDecision decision) {
        PausedCall call = paused.get(callId);
        if (call == null) {
            return;
        }
        if (!decision.isFromUser()) {
            paused.remove(callId);
            return;
        }
        long now = System.currentTimeMillis();
        if (decision.isAbort()) {
            paused.put(callId, call.at(PauseStage.FINISHED,
                    call.cycle().released(false, now, decision.editSummary()).finished(now, "aborted", null, null)));
        } else if ("response".equals(call.phase())) {
            // The supplier already answered; releasing the response IS the end of the cycle.
            PausedCall.Cycle cycle = call.cycle().releasedAt() == null
                    ? call.cycle().released(false, now, null)
                    : call.cycle();
            paused.put(callId, call.at(PauseStage.FINISHED,
                    cycle.finished(now, "completed", null, decision.editSummary())));
        } else {
            paused.put(callId, call.at(PauseStage.IN_FLIGHT,
                    call.cycle().released(decision.follow(), now, decision.editSummary())));
        }
        trimFinished();
    }

    @Override
    public void completed(String callId, PausedCall.Http response, String outcome, String note) {
        PausedCall call = paused.get(callId);
        if (call == null) {
            return;
        }
        long now = System.currentTimeMillis();
        // The snapshot on the card is what the supplier said; this is what the caller actually
        // got, edits included. Showing the latter is the point of following a call to the end -
        // what was changed on the way is already summarised in the cycle.
        PausedCall withResponse = response == null ? call : call.withResponse(response);
        // A card already finished by a decision keeps that outcome: "aborted" is more specific
        // than the "completed" the proxy reports for every cycle that reached this point.
        String ending = call.stage() == PauseStage.FINISHED && call.cycle().outcome() != null
                ? call.cycle().outcome()
                : (outcome == null ? "completed" : outcome);
        paused.put(callId, withResponse.at(PauseStage.FINISHED,
                withResponse.cycle().finished(now, ending, note, null)));
        handoffs.remove(callId);
        trimFinished();
        notifications.pausedCallsChanged();
    }

    @Override
    public boolean close(String callId) {
        PausedCall call = paused.get(callId);
        if (call == null) {
            return false;
        }
        if (call.holdsCaller()) {
            // Dismissing a card whose caller is still waiting would orphan a real socket with no
            // way back to it. Decide on it first; the card can be closed afterwards.
            return false;
        }
        paused.remove(callId);
        handoffs.remove(callId);
        notifications.pausedCallsChanged();
        return true;
    }

    @Override
    public int closeFinished() {
        int closed = 0;
        for (PausedCall call : List.copyOf(paused.values())) {
            if (call.stage() == PauseStage.FINISHED && paused.remove(call.callId()) != null) {
                closed++;
            }
        }
        if (closed > 0) {
            notifications.pausedCallsChanged();
        }
        return closed;
    }

    /**
     * Finished cards are kept for reading, not for ever. Oldest go first, so a long session
     * leaves you the calls you just looked at rather than the ones from an hour ago.
     */
    private void trimFinished() {
        List<PausedCall> finished = paused.values().stream()
                .filter(call -> call.stage() == PauseStage.FINISHED)
                .sorted(Comparator.comparingLong(PausedCall::pausedAt))
                .toList();
        for (int i = 0; i < finished.size() - MAX_FINISHED_CARDS; i++) {
            paused.remove(finished.get(i).callId());
        }
    }

    @Override
    public int releaseAll() {
        int released = 0;
        for (PausedCall call : List.copyOf(paused.values())) {
            if (call.holdsCaller() && decide(call.callId(), PauseDecision.release())) {
                released++;
                // The panic button's whole purpose is to clear the screen. Leaving a card behind
                // for every call it just let go would be the opposite of what was pressed.
                paused.remove(call.callId());
            }
        }
        if (released > 0) {
            notifications.pausedCallsChanged();
        }
        return released;
    }

    @Override
    public void resolved(String callId) {
        handoffs.remove(callId);
        // Only a row still HOLDING is dropped. "The proxy stopped waiting" is posted after EVERY
        // decision, including one that moved this call on to in-flight - and deleting the row
        // then would undo the whole point of following it. A row still holding when the proxy has
        // walked away is a row nobody can decide on, and that is the one to remove.
        PausedCall call = paused.get(callId);
        if (call != null && call.holdsCaller()) {
            paused.remove(callId);
            notifications.pausedCallsChanged();
        }
    }

    /**
     * The backstop. Each proxy enforces its own timeout too, so this is not the primary mechanism -
     * it exists so the INSPECTOR stops showing a row for a call whose proxy has already given up
     * and moved on. A stale row is worse than a missing one: it invites a decision that will never
     * reach anything.
     */
    @Scheduled(fixedDelay = 1000)
    void expire() {
        long now = System.currentTimeMillis();
        for (PausedCall call : List.copyOf(paused.values())) {
            if (!call.holdsCaller()) {
                // Nobody is waiting on this one, so there is nothing to expire it out of. The
                // exception is a followed call whose answer never arrived - the proxy died, or
                // the connection was reset somewhere the error hook could not see. Saying so is
                // better than leaving a spinner turning for the rest of the session.
                Long releasedAt = call.cycle().releasedAt();
                if (call.stage() == PauseStage.IN_FLIGHT && releasedAt != null && now > releasedAt + MAX_HELD_MS) {
                    log.warn("Followed call {} never came back from upstream and has been marked finished",
                            call.callId());
                    completed(call.callId(), null, "never-came-back",
                            "No response reached Alfred within the hour after this call was released.");
                }
                continue;
            }
            if (call.isHeld()) {
                // Somebody is working on it. Only the outer backstop applies - see MAX_HELD_MS.
                if (now > call.heldAt() + MAX_HELD_MS) {
                    log.warn("Call {} was held under manual control for over {} minutes and has been released",
                            call.callId(), MAX_HELD_MS / 60_000);
                    decide(call.callId(), PauseDecision.timedOut(call.onTimeout()));
                    resolved(call.callId());
                }
                continue;
            }
            // A second of slack, so this never beats the proxy to its own deadline and steals a
            // decision the user was about to make.
            if (now > call.expiresAt() + 1000) {
                log.info("Call {} paused by '{}' timed out after {}s", call.callId(), call.ruleName(),
                        call.timeoutSeconds());
                decide(call.callId(), PauseDecision.timedOut(call.onTimeout()));
                resolved(call.callId());
            }
        }
    }
}
