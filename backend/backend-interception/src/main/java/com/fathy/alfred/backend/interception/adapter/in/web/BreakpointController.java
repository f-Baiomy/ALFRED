package com.fathy.alfred.backend.interception.adapter.in.web;

import com.fathy.alfred.backend.interception.application.port.in.BreakpointUseCase;
import com.fathy.alfred.backend.interception.domain.model.PauseDecision;
import com.fathy.alfred.backend.interception.domain.model.PausedCall;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.context.request.async.DeferredResult;

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
 * <p>The long poll holds a CONNECTION, never a thread. It used to block the servlet thread that
 * picked the request up, on the reasoning that concurrent holds are "bounded by how many calls a
 * human is looking at, not by traffic volume" - which is simply untrue of a rule that pauses
 * everything it matches, where the bound is traffic multiplied by pause duration. Every paused
 * call then permanently occupied one of the container's workers, so enough of them at once and the
 * whole backend stops answering anything at all: the dashboard, the proxy's own webhooks, even new
 * WebSocket handshakes. Returning a {@link DeferredResult} hands the worker straight back and
 * completes the response when a decision actually arrives. See BreakpointUseCase.awaitDecision.
 */
@RestController
@RequestMapping("/interception")
public class BreakpointController {

    /** Upper bound on one long poll regardless of what the caller asks for, so a bad `waitMs` cannot hold a connection open indefinitely. */
    private static final long MAX_WAIT_MS = 10_000;

    /** How much later than the service's own deadline the container gives up, so the two never race to answer. */
    private static final long TIMEOUT_GRACE_MS = 1_000;

    private static final ResponseEntity<PauseDecision> NOTHING_YET = ResponseEntity.noContent().build();

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

    /**
     * Frontend → backend: what is currently waiting.
     *
     * <p>Summaries, never bodies - see {@link PausedCall#summary()} for the measurements behind
     * that. One card's bodies come from the endpoint below, when somebody actually opens it.
     */
    @GetMapping("/paused")
    public List<PausedCall> pending() {
        return breakpoints.pending().stream().map(PausedCall::summary).toList();
    }

    /** Frontend → backend: one card in full, bodies included, because the user opened it. */
    @GetMapping("/paused/{callId}")
    public ResponseEntity<PausedCall> detail(@PathVariable String callId) {
        return breakpoints.find(callId)
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    /**
     * Proxy → backend: park until somebody decides, or until the window closes.
     *
     * <p>Three answers, and the difference between the last two is load-bearing: 200 with a
     * decision, 204 "nothing yet, ask again", 404 "this call is over, stop asking". Answering 204
     * for a call that is no longer waiting is what froze a whole machine - the proxy cannot tell it
     * apart from a quiet window, so it re-asks with no delay and the pair spin at maximum request
     * rate until the deadline, which after a take-control is an hour away.
     */
    @GetMapping("/paused/{callId}/decision")
    public DeferredResult<ResponseEntity<PauseDecision>> awaitDecision(@PathVariable String callId,
                                                                       @RequestParam(defaultValue = "5000") long waitMs) {
        long wait = Math.min(Math.max(waitMs, 0), MAX_WAIT_MS);
        // The container's own timeout is only a backstop, a second past the one the service
        // applies - whichever fires, the answer is the same "nothing yet, ask again", never an
        // async-timeout error page the proxy would have to interpret.
        DeferredResult<ResponseEntity<PauseDecision>> result =
                new DeferredResult<>(wait + TIMEOUT_GRACE_MS, NOTHING_YET);
        if (!breakpoints.isWaiting(callId)) {
            result.setResult(ResponseEntity.notFound().build());
            return result;
        }
        breakpoints.awaitDecision(callId, wait).whenComplete((decision, error) -> result.setResult(
                error != null || decision.isEmpty() ? NOTHING_YET : ResponseEntity.ok(decision.get())));
        return result;
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

    /**
     * Proxy → backend: a followed call's cycle is over, here is how it ended.
     *
     * <p>Fire-and-forget on the proxy side and deliberately cheap here: it arrives after the
     * response has already gone back to the caller, so nothing is waiting on this request.
     */
    @PostMapping("/paused/{callId}/completed")
    public ResponseEntity<Void> completed(@PathVariable String callId, @RequestBody CompletedRequest body) {
        breakpoints.completed(callId, body.response(), body.outcome(), body.note());
        return ResponseEntity.noContent().build();
    }

    public record CompletedRequest(PausedCall.Http response, String outcome, String note) {
    }

    /** Frontend → backend: I have finished reading this card, take it away. */
    @DeleteMapping("/paused/{callId}")
    public ResponseEntity<Void> close(@PathVariable String callId) {
        // 409 rather than 404: the call is very much there, it is just still holding somebody.
        if (breakpoints.pending().stream().anyMatch(c -> c.callId().equals(callId) && c.holdsCaller())) {
            return ResponseEntity.status(HttpStatus.CONFLICT).build();
        }
        return breakpoints.close(callId)
                ? ResponseEntity.noContent().build()
                : ResponseEntity.notFound().build();
    }

    /** Frontend → backend: clear every card whose call is over. */
    @PostMapping("/paused/close-finished")
    public Map<String, Integer> closeFinished() {
        return Map.of("closed", breakpoints.closeFinished());
    }
}
