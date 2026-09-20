package com.fathy.alfred.backend.interception.adapter.in.web;

import com.fathy.alfred.backend.interception.application.port.in.BreakpointUseCase;
import com.fathy.alfred.backend.interception.domain.model.PauseDecision;
import com.fathy.alfred.backend.interception.domain.model.PausedCall;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * Two very different clients share this controller.
 *
 * <p>The PROXY calls {@code /paused} (register) and {@code /paused/{id}/decision} (long poll). The
 * FRONTEND calls {@code /paused} (list) and {@code /paused/{id}/decision} (POST a decision). They
 * are grouped here rather than split because they are two ends of one handoff and keeping them
 * together is what makes the protocol readable.
 *
 * <p>The long poll deliberately holds a servlet thread. That is affordable precisely because it
 * only ever happens for a call somebody has explicitly asked to pause: the number of concurrent
 * holds is bounded by how many calls a human is looking at, not by traffic volume. The poll window
 * is also short (the proxy asks for a few seconds at a time and re-asks), so a thread is never
 * parked for the whole of a long pause.
 */
@RestController
@RequestMapping("/interception")
public class BreakpointController {

    /** Upper bound on one long poll regardless of what the caller asks for, so a bad `waitMs` cannot park a thread indefinitely. */
    private static final long MAX_WAIT_MS = 10_000;

    private final BreakpointUseCase breakpoints;

    public BreakpointController(BreakpointUseCase breakpoints) {
        this.breakpoints = breakpoints;
    }

    /** Proxy → backend: this call is now held, show it to somebody. */
    @PostMapping("/paused")
    public ResponseEntity<Void> register(@RequestBody PausedCall call) {
        // pausedAt is stamped here, not taken from the proxy: the countdown the user sees has to
        // be measured on the clock the UI is reading, and two containers' clocks routinely differ
        // by enough to show a timer that starts at 27 seconds or at 34.
        breakpoints.register(new PausedCall(
                call.callId(), call.phase(), call.source(), call.serviceName(), call.ruleId(), call.ruleName(),
                call.timeoutSeconds(), call.onTimeout(), call.method(), call.url(),
                call.request(), call.response(), System.currentTimeMillis(), null));
        return ResponseEntity.accepted().build();
    }

    /** Frontend → backend: what is currently waiting. */
    @GetMapping("/paused")
    public List<PausedCall> pending() {
        return breakpoints.pending();
    }

    /** Proxy → backend: park until somebody decides, or until the window closes. 204 means "nothing yet, ask again". */
    @GetMapping("/paused/{callId}/decision")
    public ResponseEntity<PauseDecision> awaitDecision(@PathVariable String callId,
                                                       @RequestParam(defaultValue = "5000") long waitMs)
            throws InterruptedException {
        return breakpoints.awaitDecision(callId, Math.min(Math.max(waitMs, 0), MAX_WAIT_MS))
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.noContent().build());
    }

    /** Frontend → backend: the user's decision. 404 once that call is no longer waiting. */
    @PostMapping("/paused/{callId}/decision")
    public ResponseEntity<Void> decide(@PathVariable String callId, @RequestBody PauseDecision decision) {
        return breakpoints.decide(callId, decision)
                ? ResponseEntity.noContent().build()
                : ResponseEntity.notFound().build();
    }

    /**
     * Frontend → backend: I am looking at this one, stop the clock.
     *
     * Separate from a decision on purpose. The countdown exists so a call nobody noticed does not
     * hang its caller; it should not also be a deadline for reading a 200 KB body and deciding
     * what to change.
     */
    @PostMapping("/paused/{callId}/control")
    public ResponseEntity<Void> takeControl(@PathVariable String callId) {
        return breakpoints.takeControl(callId)
                ? ResponseEntity.noContent().build()
                : ResponseEntity.notFound().build();
    }

    /** The panic button: let everything go, untouched. */
    @PostMapping("/paused/release-all")
    public Map<String, Integer> releaseAll() {
        return Map.of("released", breakpoints.releaseAll());
    }

    /** Proxy → backend: I have stopped waiting on this one, drop it from the queue. */
    @PostMapping("/paused/{callId}/resolved")
    public ResponseEntity<Void> resolved(@PathVariable String callId) {
        breakpoints.resolved(callId);
        return ResponseEntity.noContent().build();
    }
}
