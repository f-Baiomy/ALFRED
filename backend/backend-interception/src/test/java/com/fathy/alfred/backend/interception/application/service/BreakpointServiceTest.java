package com.fathy.alfred.backend.interception.application.service;

import com.fathy.alfred.backend.interception.application.port.out.InterceptionNotificationPort;
import com.fathy.alfred.backend.interception.domain.model.PauseDecision;
import com.fathy.alfred.backend.interception.domain.model.PauseStage;
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
        PauseDecision edited = new PauseDecision("release", 500, Map.of(), "{\"status\":\"FAILED\"}", null, false);
        assertThat(service.decide("c1", edited)).isTrue();

        Optional<PauseDecision> received = waiting.get(3, TimeUnit.SECONDS);
        assertThat(received).isPresent();
        assertThat(received.get().status()).isEqualTo(500);
        assertThat(received.get().body()).contains("FAILED");
        // The row stays, as a finished card. It holds nobody now - see stageTest below - but it
        // used to vanish the instant a decision went out, which is exactly what made following a
        // call through its cycle impossible.
        assertThat(service.pending()).extracting(PausedCall::stage).containsExactly(PauseStage.FINISHED);
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

        assertThat(service.decide("c1", new PauseDecision("release", 500, Map.of(), "edited", null, false))).isTrue();
        assertThat(waiting.get(3, TimeUnit.SECONDS).orElseThrow().body()).isEqualTo("edited");
        assertThat(service.pending()).extracting(PausedCall::stage).containsExactly(PauseStage.FINISHED);
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

    // ---- following a call past the half it was paused on -------------------------------------
    //
    // A request breakpoint used to vanish the moment you pressed Send, so you never saw what came
    // back. These cover the three-stage life a card has now, and the two properties that make it
    // safe: nothing that holds a caller is ever hidden, and nothing a human did not decide on
    // leaves a card behind.

    private static PausedCall requestPause(String id) {
        return new PausedCall(id, "request", "outbound", null, "rule-1", "Review orders",
                30, "release", "POST", "https://api.sabre.com/v4/order/create",
                new PausedCall.Http(null, Map.of(), "{}"), null,
                System.currentTimeMillis(), null);
    }

    /** Releases a registered call the way the inspector does, with a poller parked on it. */
    private void releaseAsUser(String callId, PauseDecision decision) throws Exception {
        CompletableFuture<Optional<PauseDecision>> waiting = CompletableFuture.supplyAsync(() -> {
            try {
                return service.awaitDecision(callId, 5000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return Optional.empty();
            }
        });
        Thread.sleep(100);
        assertThat(service.decide(callId, decision)).isTrue();
        waiting.get(3, TimeUnit.SECONDS);
    }

    @Test
    void releasingARequestLeavesTheCardInFlightRatherThanDeletingIt() throws Exception {
        service.register(requestPause("c1"));

        releaseAsUser("c1", PauseDecision.release());

        PausedCall card = service.pending().get(0);
        assertThat(card.stage()).isEqualTo(PauseStage.IN_FLIGHT);
        assertThat(card.holdsCaller()).isFalse();
        assertThat(card.cycle().releasedAt()).isNotNull();
    }

    @Test
    void theProxySayingItStoppedWaitingDoesNotDeleteACardBeingFollowed() throws Exception {
        // The proxy posts /resolved after EVERY decision, including one that just moved this call
        // on to in-flight. Deleting the row then would undo the entire feature - and since that
        // post arrives on another thread, decide() has to advance the stage BEFORE handing the
        // decision over, or there is a window where it does exactly that.
        service.register(requestPause("c1"));
        releaseAsUser("c1", PauseDecision.release());

        service.resolved("c1");

        assertThat(service.pending()).extracting(PausedCall::callId).containsExactly("c1");
    }

    @Test
    void aCallStillHoldingWhenTheProxyWalksAwayIsStillDropped() {
        // The other half of the same rule: resolved() has to keep working for the case it was
        // written for, or a row nobody can decide on stays on screen inviting a decision.
        service.register(requestPause("c1"));

        service.resolved("c1");

        assertThat(service.pending()).isEmpty();
    }

    @Test
    void aDecisionNobodyMadeLeavesNoCardAtAll() throws Exception {
        // A rule that pauses everything times out dozens of calls on busy traffic. A card for
        // each would bury the one being worked on under the ones nobody ever saw.
        service.register(requestPause("c1"));

        releaseAsUser("c1", PauseDecision.timedOut("release"));

        assertThat(service.pending()).isEmpty();
    }

    @Test
    void theAnswerToAFollowedCallComesBackToTheSameCard() throws Exception {
        service.register(requestPause("c1"));
        releaseAsUser("c1", new PauseDecision("release", null, null, "{\"edited\":1}", null, true));

        // The proxy pauses the response half under the same id - see interception.follow_pause.
        PausedCall responseHalf = new PausedCall("c1", "response", "outbound", null, "rule-1",
                "Review orders", 30, "release", "POST", "https://api.sabre.com/v4/order/create",
                new PausedCall.Http(null, Map.of(), "{\"edited\":1}"),
                new PausedCall.Http(503, Map.of(), "{}"), System.currentTimeMillis(), null);
        service.register(responseHalf);

        assertThat(service.pending()).hasSize(1);
        PausedCall card = service.pending().get(0);
        assertThat(card.stage()).isEqualTo(PauseStage.HOLDING);
        assertThat(card.phase()).isEqualTo("response");
        // Everything learned on the first half survives - without this the card would come back
        // as a bare response pause and the cycle the user asked to see would be half missing.
        assertThat(card.cycle().follow()).isTrue();
        assertThat(card.cycle().requestEdit()).isEqualTo("body");
        assertThat(card.cycle().releasedAt()).isNotNull();
    }

    @Test
    void theProxyReportingTheEndOfTheCycleFinishesTheCard() throws Exception {
        service.register(requestPause("c1"));
        releaseAsUser("c1", PauseDecision.release());

        service.completed("c1", new PausedCall.Http(200, Map.of(), "{\"ok\":true}"), "completed", null);

        PausedCall card = service.pending().get(0);
        assertThat(card.stage()).isEqualTo(PauseStage.FINISHED);
        assertThat(card.response().body()).contains("ok");
        assertThat(card.cycle().durationMs()).isNotNull();
    }

    @Test
    void anAbortKeepsItsOwnOutcomeWhenTheProxyReportsTheCycleEnded() throws Exception {
        service.register(call("c1", 30, "release"));
        releaseAsUser("c1", new PauseDecision("abort", null, null, null, null, false));

        service.completed("c1", null, "completed", null);

        assertThat(service.pending().get(0).cycle().outcome()).isEqualTo("aborted");
    }

    @Test
    void mockingAConnectionKillingFailureFinishesTheCardExactlyLikeAnAbort() throws Exception {
        // CONNECTION_RESET reaches the caller as nothing at all - the same as a plain abort - so
        // this has to be finished the same way, not left IN_FLIGHT waiting on a response that the
        // proxy is about to make sure never arrives. See PauseDecision.endsConnection.
        service.register(requestPause("c1"));
        releaseAsUser("c1", new PauseDecision("simulate_failure", null, null, null, null, false,
                new PauseDecision.PauseFailure("CONNECTION_RESET", null, null, null)));

        PausedCall card = service.pending().get(0);
        assertThat(card.stage()).isEqualTo(PauseStage.FINISHED);
        assertThat(card.cycle().outcome()).isEqualTo("aborted");
        assertThat(card.cycle().requestEdit()).isEqualTo("network failure: CONNECTION_RESET");
    }

    @Test
    void mockingAFabricatedResponseFailureLeavesTheCardInFlightLikeARelease() throws Exception {
        // GATEWAY_ERROR still sends something back to the caller - a deliberately broken 502, but
        // a response all the same - so from this bookkeeping's point of view it is a release: a
        // reply is still coming, whether or not it is honest about what happened upstream.
        service.register(requestPause("c1"));
        releaseAsUser("c1", new PauseDecision("simulate_failure", null, null, null, null, false,
                new PauseDecision.PauseFailure("GATEWAY_ERROR", null, 502, null)));

        PausedCall card = service.pending().get(0);
        assertThat(card.stage()).isEqualTo(PauseStage.IN_FLIGHT);
        assertThat(card.cycle().requestEdit()).isEqualTo("network failure: GATEWAY_ERROR");
    }

    @Test
    void aFollowedCallThatNeverComesBackIsSaidSoRatherThanSpinningForever() throws Exception {
        service.register(requestPause("c1"));
        releaseAsUser("c1", PauseDecision.release());
        // Released an hour and a half ago and still in flight: the proxy died, or the connection
        // was reset somewhere no error hook could see it.
        PausedCall stuck = service.pending().get(0);
        service.completed("c1", null, "never-came-back", "No response reached Alfred.");

        assertThat(stuck.stage()).isEqualTo(PauseStage.IN_FLIGHT);
        assertThat(service.pending().get(0).stage()).isEqualTo(PauseStage.FINISHED);
        assertThat(service.pending().get(0).cycle().outcome()).isEqualTo("never-came-back");
    }

    @Test
    void aFinishedCardIsClosedByHandAndAHoldingOneIsNot() throws Exception {
        service.register(requestPause("held"));
        service.register(requestPause("done"));
        releaseAsUser("done", PauseDecision.release());
        service.completed("done", null, "completed", null);

        // Dismissing a card whose caller is still waiting would orphan a real socket.
        assertThat(service.close("held")).isFalse();
        assertThat(service.close("done")).isTrue();
        assertThat(service.pending()).extracting(PausedCall::callId).containsExactly("held");
    }

    @Test
    void closeFinishedLeavesEverythingThatIsStillRunning() throws Exception {
        service.register(requestPause("holding"));
        service.register(requestPause("flying"));
        service.register(requestPause("done"));
        releaseAsUser("flying", PauseDecision.release());
        releaseAsUser("done", PauseDecision.release());
        service.completed("done", null, "completed", null);

        assertThat(service.closeFinished()).isEqualTo(1);
        assertThat(service.pending()).extracting(PausedCall::callId).containsExactlyInAnyOrder("holding", "flying");
    }

    @Test
    void thePanicButtonClearsTheScreenRatherThanLeavingACardPerCall() throws Exception {
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

        assertThat(service.releaseAll()).isEqualTo(1);

        // "Let everything go" means the screen too - that is what the button is for.
        assertThat(service.pending()).isEmpty();
        assertThat(waiting.get(3, TimeUnit.SECONDS)).isPresent();
    }

    @Test
    void finishedCardsDoNotAccumulateWithoutLimit() throws Exception {
        for (int i = 0; i < 25; i++) {
            service.register(requestPause("c" + i));
            releaseAsUser("c" + i, PauseDecision.release());
            service.completed("c" + i, null, "completed", null);
        }

        // Oldest go first, so a long session leaves the calls you just looked at.
        assertThat(service.pending()).hasSize(20);
        assertThat(service.pending()).extracting(PausedCall::callId).doesNotContain("c0", "c4");
        assertThat(service.pending()).extracting(PausedCall::callId).contains("c24");
    }

    @Test
    void holdingCallsSortAboveEverythingElse() throws Exception {
        service.register(requestPause("done"));
        releaseAsUser("done", PauseDecision.release());
        service.completed("done", null, "completed", null);
        service.register(requestPause("flying"));
        releaseAsUser("flying", PauseDecision.release());
        service.register(requestPause("holding"));

        // The one with somebody waiting on it goes to the top, wherever it arrived in the order.
        assertThat(service.pending()).extracting(PausedCall::callId)
                .containsExactly("holding", "flying", "done");
    }

    @Test
    void anEditSummaryNamesTheHeadersChangedAndNeverTheirValues() {
        // Same rule the redaction records follow. A summary echoing "authorization: Bearer ey..."
        // would put a credential on a screen that has no business holding one.
        Map<String, String> headers = new java.util.LinkedHashMap<>();
        headers.put("authorization", "Bearer super-secret-token");
        headers.put("x-gone", null);
        PauseDecision decision = new PauseDecision("release", 418, headers, "{}", null, false);

        String summary = decision.editSummary();

        assertThat(summary).contains("status 418", "header authorization", "-x-gone", "body");
        assertThat(summary).doesNotContain("super-secret-token");
    }

    @Test
    void anUntouchedReleaseSummarisesAsNothingAtAll() {
        assertThat(PauseDecision.release().editSummary()).isNull();
    }
}
