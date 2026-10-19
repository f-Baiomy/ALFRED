package com.fathy.alfred.backend.links.application.service;

import com.fathy.alfred.backend.links.application.port.out.EnvBoardPort;
import com.fathy.alfred.backend.links.domain.model.EnvMark;
import com.fathy.alfred.backend.links.domain.model.EnvRetest;
import com.fathy.alfred.backend.links.domain.model.EnvStep;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/** One environment's column of the Task tab matrix (D38-D40): what makes it PASS, FAIL or WAITING. */
class EnvVerdictTest {

    private static final Instant T = Instant.parse("2026-10-19T08:00:00Z");
    private static final EnvBoardPort.Asks ASKS = new EnvBoardPort.Asks(
            List.of(new EnvBoardPort.Item("spec.md", "AC1", "Refund shows the new total")), List.of("s1"), List.of(7));

    private static EnvMark mark(String m) {
        return new EnvMark("H", "B", "spec.md", "AC1", m, "", "user", T, null);
    }

    private static EnvStep step(String state) {
        return new EnvStep("H", "B", "s1", state, null, "user", T);
    }

    private static EnvRetest retest(int card, String verdict) {
        return new EnvRetest("H", "B", card, verdict, "", "c9", "claude", T);
    }

    @Test
    void everythingAskedAndSeenPasses() {
        List<String> missing = new ArrayList<>();
        assertThat(EnvService.verdict(ASKS, List.of(mark("PASS")), List.of(step("SEEN")), List.of(retest(7, "PASS")), true, missing))
                .isEqualTo("PASS");
        assertThat(missing).isEmpty();
    }

    @Test
    void whatIsNotDoneYetIsNamed() {
        List<String> missing = new ArrayList<>();
        assertThat(EnvService.verdict(ASKS, List.of(), List.of(), List.of(), true, missing)).isEqualTo("WAITING");
        assertThat(missing).containsExactly("requirement Refund shows the new total", "step s1", "re-test #7");
    }

    @Test
    void oneFailureFailsTheColumnEvenWithOtherThingsMissing() {
        List<String> missing = new ArrayList<>();
        assertThat(EnvService.verdict(ASKS, List.of(mark("FAIL")), List.of(), List.of(), true, missing)).isEqualTo("FAIL");
        assertThat(EnvService.verdict(ASKS, List.of(), List.of(step("FAILED")), List.of(), true, new ArrayList<>())).isEqualTo("FAIL");
        assertThat(EnvService.verdict(ASKS, List.of(), List.of(), List.of(retest(7, "FAIL")), true, new ArrayList<>())).isEqualTo("FAIL");
    }

    @Test
    void aFailedReTestOfACardNoLongerFixedIsNotHeldAgainstIt() {
        assertThat(EnvService.verdict(ASKS, List.of(mark("PASS")), List.of(step("SEEN")), List.of(retest(7, "PASS"), retest(3, "FAIL")),
                true, new ArrayList<>())).isEqualTo("PASS");
    }

    @Test
    void anEnvironmentThatCannotBeReadIsWaitingNeverFailing() {
        List<String> missing = new ArrayList<>();
        assertThat(EnvService.verdict(ASKS, List.of(mark("FAIL")), List.of(), List.of(), false, missing)).isEqualTo("WAITING");
        assertThat(missing).containsExactly("offline");
    }

    @Test
    void aReTestCycleIsNamedAfterItsCardsAndEnvironment() {
        assertThat(EnvService.retestName(List.of(7), "STG")).isEqualTo("Re-test #7 · STG");
        assertThat(EnvService.retestName(List.of(1, 2, 3, 4, 5), "UAT")).isEqualTo("Re-test #1 #2 #3 +2 · UAT");
    }
}
