package com.fathy.alfred.backend.interception.application.service;

import com.fathy.alfred.backend.interception.application.port.out.InterceptionNotificationPort;
import com.fathy.alfred.backend.interception.domain.model.PauseDecision;
import com.fathy.alfred.backend.interception.domain.model.PausedCall;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

class BreakpointServiceTest {

    private AtomicInteger pausedNotifications;
    private BreakpointService service;

    @BeforeEach
    void setUp() {
        pausedNotifications = new AtomicInteger();
        service = new BreakpointService(new InterceptionNotificationPort() {
            public void rulesChanged() {
            }

            public void pausedCallsChanged() {
                pausedNotifications.incrementAndGet();
            }
        });
    }

    private static PausedCall call(String id, int timeoutSeconds, String onTimeout) {
        return new PausedCall(id, "response", "outbound", null, "rule-1", "Review orders",
                timeoutSeconds, onTimeout, "POST", "https://api.sabre.com/v4/order/create",
                new PausedCall.Http(null, Map.of(), "{}"),
                new PausedCall.Http(200, Map.of(), "{\"status\":\"CONFIRMED\"}"),
                System.currentTimeMillis(), null);
    }

    @Test
    void aRegisteredCallIsListedAndAnnounced() {
        service.register(call("c1", 30, "release"));

        assertThat(service.pending()).extracting(PausedCall::callId).containsExactly("c1");
        assertThat(pausedNotifications.get()).isEqualTo(1);
    }

    @Test
    void pendingIsOldestFirstSoTheMostUrgentIsAtTheTop() throws InterruptedException {
        service.register(call("first", 30, "release"));
        Thread.sleep(5);
        service.register(call("second", 30, "release"));

        assertThat(service.pending()).extracting(PausedCall::callId).containsExactly("first", "second");
    }

    @Test
    void awaitingAnUnknownCallReturnsImmediatelyRatherThanBlocking() throws InterruptedException {
        long started = System.currentTimeMillis();

        assertThat(service.awaitDecision("never-registered", 5000)).isEmpty();
        assertThat(System.currentTimeMillis() - started).isLessThan(500);
    }

    @Test
    void awaitingReturnsEmptyOnceTheWindowClosesSoTheProxyCanPollAgain() throws InterruptedException {
        service.register(call("c1", 30, "release"));

        assertThat(service.awaitDecision("c1", 120)).isEmpty();
        // Still waiting - a closed poll window is not a resolution.
        assertThat(service.pending()).hasSize(1);
    }

    @Test
    void aDecisionIsHandedToTheWaitingProxy() throws Exception {
        service.register(call("c1", 30, "release"));

        CompletableFuture<Optional<PauseDecision>> waiting = CompletableFuture.supplyAsync(() -> {
            try {
                return service.awaitDecision("c1", 5000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return Optional.empty();
            }
        });

        // Give the poller a moment to park on the queue before offering.
        Thread.sleep(100);
        PauseDecision edited = new PauseDecision("release", 500, Map.of(), "{\"status\":\"FAILED\"}", null);
        assertThat(service.decide("c1", edited)).isTrue();

        Optional<PauseDecision> received = waiting.get(3, TimeUnit.SECONDS);
        assertThat(received).isPresent();
        assertThat(received.get().status()).isEqualTo(500);
        assertThat(received.get().body()).contains("FAILED");
        assertThat(service.pending()).isEmpty();
    }

    @Test
    void decidingOnACallNobodyIsWaitingForReportsFailureRatherThanBlocking() {
        long started = System.currentTimeMillis();

        // Registered, but with no proxy parked on the handoff - offer must not block an HTTP thread.
        service.register(call("c1", 30, "release"));

        assertThat(service.decide("c1", PauseDecision.release())).isFalse();
        assertThat(System.currentTimeMillis() - started).isLessThan(500);
    }

    @Test
    void decidingOnAnUnknownCallIsFalse() {
        assertThat(service.decide("nope", PauseDecision.release())).isFalse();
    }

    @Test
    void resolvedDropsTheCallFromTheQueue() {
        service.register(call("c1", 30, "release"));

        service.resolved("c1");

        assertThat(service.pending()).isEmpty();
    }

    @Test
    void expirySweepDropsACallWhoseDeadlineHasPassed() {
        // pausedAt far enough in the past that expiresAt plus the sweep's slack is behind us.
        PausedCall stale = new PausedCall("old", "response", "outbound", null, "r", "Rule",
                1, "release", "POST", "https://x/y", null, null,
                System.currentTimeMillis() - 10_000, null);
        service.register(stale);

        service.expire();

        assertThat(service.pending()).isEmpty();
    }

    @Test
    void expirySweepLeavesACallThatStillHasTimeLeft() {
        service.register(call("fresh", 300, "release"));

        service.expire();

        assertThat(service.pending()).hasSize(1);
    }

    @Test
    void takingControlStopsTheCountdownAndSurvivesTheExpirySweep() {
        // A call that would have expired ten seconds ago. Once somebody has it, the sweep must
        // leave it alone - being released mid-edit is the exact thing this prevents.
        PausedCall aboutToExpire = new PausedCall("c1", "response", "outbound", null, "r", "Rule",
                1, "release", "POST", "https://x/y", null, null,
                System.currentTimeMillis() - 10_000, null);
        service.register(aboutToExpire);

        assertThat(service.takeControl("c1")).isTrue();
        service.expire();

        assertThat(service.pending()).hasSize(1);
        assertThat(service.pending().get(0).isHeld()).isTrue();
    }

    @Test
    void aCallNobodyTookControlOfStillExpires() {
        PausedCall aboutToExpire = new PausedCall("c1", "response", "outbound", null, "r", "Rule",
                1, "release", "POST", "https://x/y", null, null,
                System.currentTimeMillis() - 10_000, null);
        service.register(aboutToExpire);

        service.expire();

        assertThat(service.pending()).isEmpty();
    }

    @Test
    void takingControlTellsTheWaitingProxyImmediately() throws Exception {
        service.register(call("c1", 30, "release"));

        CompletableFuture<Optional<PauseDecision>> waiting = CompletableFuture.supplyAsync(() -> {
            try {
                return service.awaitDecision("c1", 5000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return Optional.empty();
            }
        });
        Thread.sleep(100);

        service.takeControl("c1");

        // The proxy is still counting down against its own deadline until it hears this, and that
        // gap is exactly where a call would be released while somebody was typing into it.
        Optional<PauseDecision> received = waiting.get(3, TimeUnit.SECONDS);
        assertThat(received).isPresent();
        assertThat(received.get().action()).isEqualTo("hold");
    }

    @Test
    void takingControlDoesNotRemoveTheCallFromTheQueue() {
        service.register(call("c1", 30, "release"));

        service.takeControl("c1");

        // A hold is not a decision - the call is still waiting, and still has to be listed.
        assertThat(service.pending()).hasSize(1);
    }

    @Test
    void takingControlTwiceIsHarmless() {
        service.register(call("c1", 30, "release"));

        assertThat(service.takeControl("c1")).isTrue();
        long firstHeldAt = service.pending().get(0).heldAt();
        assertThat(service.takeControl("c1")).isTrue();

        assertThat(service.pending().get(0).heldAt()).isEqualTo(firstHeldAt);
    }

    @Test
    void takingControlOfAnUnknownCallIsFalse() {
        assertThat(service.takeControl("nope")).isFalse();
    }

    @Test
    void aHeldCallCanStillBeReleasedAndAbortedNormally() throws Exception {
        service.register(call("c1", 30, "release"));
        service.takeControl("c1");

        CompletableFuture<Optional<PauseDecision>> waiting = CompletableFuture.supplyAsync(() -> {
            try {
                return service.awaitDecision("c1", 5000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return Optional.empty();
            }
        });
        Thread.sleep(100);

        assertThat(service.decide("c1", new PauseDecision("release", 500, Map.of(), "edited", null))).isTrue();
        assertThat(waiting.get(3, TimeUnit.SECONDS).orElseThrow().body()).isEqualTo("edited");
        assertThat(service.pending()).isEmpty();
    }

    @Test
    void releaseAllStillFreesAHeldCall() throws Exception {
        service.register(call("c1", 30, "release"));
        service.takeControl("c1");

        CompletableFuture<Optional<PauseDecision>> waiting = CompletableFuture.supplyAsync(() -> {
            try {
                return service.awaitDecision("c1", 5000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return Optional.empty();
            }
        });
        Thread.sleep(100);

        // The panic button has to mean it, even for calls somebody claimed and walked away from.
        assertThat(service.releaseAll()).isEqualTo(1);
        assertThat(waiting.get(3, TimeUnit.SECONDS)).isPresent();
    }

    @Test
    void isWaitingDistinguishesAnOpenCallFromOneThatIsOver() {
        // The whole point of this predicate: without it the long poll answers an unknown call
        // instantly, the proxy cannot tell that apart from a quiet window, and the two spin at
        // maximum request rate. Measured at 60% CPU in the proxy and 35% in the backend from one
        // call, with no cpu limits on either container.
        assertThat(service.isWaiting("never-registered")).isFalse();

        service.register(call("c1", 30, "release"));
        assertThat(service.isWaiting("c1")).isTrue();

        service.resolved("c1");
        assertThat(service.isWaiting("c1")).isFalse();
    }

    @Test
    void aCallStopsBeingWaitedOnOnceItsExpirySweepHasRun() {
        PausedCall stale = new PausedCall("old", "response", "outbound", null, "r", "Rule",
                1, "release", "POST", "https://x/y", null, null,
                System.currentTimeMillis() - 10_000, null);
        service.register(stale);

        service.expire();

        // expire() calls decide() then resolved(). When decide()'s offer finds no parked poller -
        // the common case, since the proxy is between polls most of the time - resolved() is what
        // actually removes the handoff. The proxy must then be told 404, not "nothing yet".
        assertThat(service.isWaiting("old")).isFalse();
    }

    @Test
    void timedOutDecisionFollowsTheRulesOnTimeoutSetting() {
        assertThat(PauseDecision.timedOut("abort").isAbort()).isTrue();
        assertThat(PauseDecision.timedOut("release").isAbort()).isFalse();
        assertThat(PauseDecision.timedOut(null).isAbort()).isFalse();
        assertThat(PauseDecision.timedOut("release").reason()).isEqualTo("timeout");
    }

    @Test
    void releaseAllOnlyCountsCallsSomebodyWasActuallyWaitingOn() throws Exception {
        service.register(call("waiting", 30, "release"));
        service.register(call("unattended", 30, "release"));

        CompletableFuture<Optional<PauseDecision>> waiting = CompletableFuture.supplyAsync(() -> {
            try {
                return service.awaitDecision("waiting", 5000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return Optional.empty();
            }
        });
        Thread.sleep(100);

        assertThat(service.releaseAll()).isEqualTo(1);
        assertThat(waiting.get(3, TimeUnit.SECONDS)).isPresent();
    }
}
