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
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
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
 * <p>The rendezvous is a {@link Waiter} per paused call: the proxy's long poll leaves a future
 * there and whichever thread produces a decision completes it, so a release is delivered in
 * microseconds instead of on the next poll tick. Nothing blocks on either side - see
 * {@link BreakpointUseCase#awaitDecision} for why waiting must not cost a thread.
 *
 * <p>A decision made while no poll happens to be parked is KEPT for the next one rather than
 * refused. That distinction used to be invisible and it cost real releases: the handoff was a
 * {@code SynchronousQueue}, whose {@code offer} only succeeds if a consumer is parked at that
 * exact instant, so pressing Send in the gap between two polls - or while the proxy's poll was
 * queued behind others, which is the normal state of affairs under load - silently dropped the
 * decision, rolled the card back, and let the call fall out to its timeout action instead. The
 * proxy re-asks within 250ms, so keeping it costs nothing and makes a click that was accepted
 * actually happen.
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

    /**
     * How long a decision waits to be collected by a proxy that is between polls before it is
     * assumed nobody is coming for it. The proxy's own floor between polls is 250ms, so this is
     * two orders of magnitude of slack rather than a number anything reaches while working.
     */
    private static final long UNCOLLECTED_DECISION_MS = 30_000;

    private final InterceptionNotificationPort notifications;

    private final Map<String, PausedCall> paused = new ConcurrentHashMap<>();
    private final Map<String, Waiter> handoffs = new ConcurrentHashMap<>();

    /**
     * One paused call's side of the handoff: the poll currently parked on it (if any), and a
     * decision that arrived while none was (if any). Never both at once - a decision is either
     * delivered straight to a waiting poll or kept for the next one.
     *
     * <p>{@code terminal} marks a kept decision that ENDS the wait (anything but "hold"), so the
     * poll that collects it also retires the call from the registry.
     */
    private static final class Waiter {
        private CompletableFuture<Optional<PauseDecision>> pending;
        private PauseDecision kept;
        private boolean terminal;
        private long keptAt;
    }

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
        handoffs.put(call.callId(), new Waiter());
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
    public CompletableFuture<Optional<PauseDecision>> awaitDecision(String callId, long waitMs) {
        Waiter waiter = handoffs.get(callId);
        if (waiter == null) {
            // Answering "nothing yet" here is what caused a machine-wide freeze: the caller cannot
            // tell it apart from a quiet poll window, so it re-asks immediately, forever. The
            // controller checks isWaiting first and answers 404 instead; this stays defensive for
            // the race where the call is resolved between that check and this line.
            return CompletableFuture.completedFuture(Optional.empty());
        }
        synchronized (waiter) {
            if (waiter.kept != null) {
                PauseDecision decision = waiter.kept;
                waiter.kept = null;
                if (waiter.terminal) {
                    handoffs.remove(callId);
                }
                return CompletableFuture.completedFuture(Optional.of(decision));
            }
            // A second poll for the same call supersedes the first: the proxy only ever has one in
            // flight, so an older future here belongs to a request whose connection is already
            // gone. Completing it empty retires it rather than leaving it to the timeout.
            if (waiter.pending != null) {
                waiter.pending.complete(Optional.empty());
            }
            CompletableFuture<Optional<PauseDecision>> pending = new CompletableFuture<>();
            waiter.pending = pending;
            // The JDK's shared delayed executor, not a thread per call - nothing is parked here.
            pending.completeOnTimeout(Optional.empty(), waitMs, TimeUnit.MILLISECONDS);
            pending.whenComplete((result, error) -> {
                synchronized (waiter) {
                    if (waiter.pending == pending) {
                        waiter.pending = null;
                    }
                }
            });
            return pending;
        }
    }

    /**
     * Hands a decision to the proxy: straight to a parked poll if there is one, kept for the next
     * poll if there is not. {@code terminal} is false only for "hold", which tells the proxy to
     * stop counting down and keep waiting - that call is still very much paused afterwards.
     */
    private void handOver(String callId, PauseDecision decision, boolean terminal) {
        Waiter waiter = handoffs.get(callId);
        if (waiter == null) {
            return;
        }
        synchronized (waiter) {
            if (waiter.pending != null && waiter.pending.complete(Optional.of(decision))) {
                waiter.pending = null;
                if (terminal) {
                    handoffs.remove(callId);
                }
                return;
            }
            waiter.kept = decision;
            waiter.terminal = terminal;
            waiter.keptAt = System.currentTimeMillis();
        }
    }

    /**
     * Drops this call's side of the handoff once nobody can decide on it any more.
     *
     * <p>Finishes a poll parked on it rather than walking away and leaving that request to idle
     * out: the proxy gets its "nothing yet" immediately and learns the call is gone on its next
     * ask, instead of holding a connection open for the rest of the window for an answer that is
     * never coming.
     */
    private void retire(String callId) {
        Waiter waiter = handoffs.remove(callId);
        if (waiter == null) {
            return;
        }
        synchronized (waiter) {
            if (waiter.pending != null) {
                waiter.pending.complete(Optional.empty());
                waiter.pending = null;
            }
            waiter.kept = null;
        }
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
        // exactly where a call would be released while somebody was typing into it. Kept for the
        // next poll when none is parked - this used to be dropped on the floor there, which is
        // precisely the case the comment above says must not happen.
        handOver(callId, PauseDecision.hold(), false);
        log.info("Call {} taken under manual control - its countdown is stopped", callId);
        notifications.pausedCallsChanged();
        return true;
    }

    @Override
    public boolean decide(String callId, PauseDecision decision) {
        if (!handoffs.containsKey(callId)) {
            return false;
        }
        // Moved on BEFORE the decision is handed over, and that order matters. The proxy posts
        // /resolved the instant it stops waiting, on another thread; if this row were still
        // HOLDING when that landed, resolved() would delete the very card we are turning into a
        // followed one. Advancing first means the row is already past HOLDING by then.
        advance(callId, decision);
        handOver(callId, decision, true);
        notifications.pausedCallsChanged();
        return true;
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
        // A simulated failure that KILLS the connection (see FailureMode.killsConnection) reaches
        // the caller exactly like an abort does - nothing at all - so it is finished the same way
        // here. One that fabricates a response instead (EMPTY_REPLY, TRUNCATED_BODY,
        // GATEWAY_ERROR) is a release in every way that matters to this bookkeeping: something IS
        // coming back, whether that something is honest or not.
        if (decision.endsConnection()) {
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
        retire(callId);
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
        retire(callId);
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
        retire(callId);
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
        dropUncollectedDecisions(now);
    }

    /**
     * A decision kept for a proxy that then never asked again.
     *
     * <p>Collected within 250ms in the normal case - this is only for a proxy that died, or was
     * restarted, between the click and its next poll. Without it that decision sits in the handoff
     * map for the life of the process, and a released decision carries whatever body was edited
     * into it, so "a few of those" is measured in megabytes rather than bytes.
     */
    void dropUncollectedDecisions(long now) {
        for (Map.Entry<String, Waiter> entry : handoffs.entrySet()) {
            Waiter waiter = entry.getValue();
            boolean stale;
            synchronized (waiter) {
                stale = waiter.kept != null && now - waiter.keptAt > UNCOLLECTED_DECISION_MS;
            }
            if (stale) {
                log.info("Dropping the decision for call {} - its proxy never came back to collect it",
                        entry.getKey());
                retire(entry.getKey());
            }
        }
    }
}
