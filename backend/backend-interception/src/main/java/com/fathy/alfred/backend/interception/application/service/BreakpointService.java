package com.fathy.alfred.backend.interception.application.service;

import com.fathy.alfred.backend.interception.application.port.in.BreakpointUseCase;
import com.fathy.alfred.backend.interception.application.port.out.InterceptionNotificationPort;
import com.fathy.alfred.backend.interception.domain.model.PauseDecision;
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

    private final InterceptionNotificationPort notifications;

    private final Map<String, PausedCall> paused = new ConcurrentHashMap<>();
    private final Map<String, SynchronousQueue<PauseDecision>> handoffs = new ConcurrentHashMap<>();

    public BreakpointService(InterceptionNotificationPort notifications) {
        this.notifications = notifications;
    }

    @Override
    public void register(PausedCall call) {
        paused.put(call.callId(), call);
        handoffs.put(call.callId(), new SynchronousQueue<>());
        log.info("Call {} paused by rule '{}' ({}), holding its caller for up to {}s",
                call.callId(), call.ruleName(), call.phase(), call.timeoutSeconds());
        notifications.pausedCallsChanged();
    }

    @Override
    public List<PausedCall> pending() {
        List<PausedCall> calls = new ArrayList<>(paused.values());
        // Oldest first: the one closest to timing out is the one that needs a decision soonest.
        calls.sort(Comparator.comparingLong(PausedCall::pausedAt));
        return calls;
    }

    @Override
    public Optional<PauseDecision> awaitDecision(String callId, long waitMs) throws InterruptedException {
        SynchronousQueue<PauseDecision> handoff = handoffs.get(callId);
        if (handoff == null) {
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
        // Non-blocking: if the proxy is between polls there is no consumer parked on the queue
        // right now, so this would block an HTTP worker thread for the whole poll gap. Removing
        // the call from `paused` first means the UI stops offering it either way, and the proxy
        // will find it gone on its next poll and fall back to its timeout action.
        boolean handed = handoff.offer(decision);
        if (handed) {
            paused.remove(callId);
            handoffs.remove(callId);
            notifications.pausedCallsChanged();
        }
        return handed;
    }

    @Override
    public int releaseAll() {
        int released = 0;
        for (String callId : List.copyOf(paused.keySet())) {
            if (decide(callId, PauseDecision.release())) {
                released++;
            }
        }
        return released;
    }

    @Override
    public void resolved(String callId) {
        if (paused.remove(callId) != null) {
            handoffs.remove(callId);
            notifications.pausedCallsChanged();
        } else {
            handoffs.remove(callId);
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
