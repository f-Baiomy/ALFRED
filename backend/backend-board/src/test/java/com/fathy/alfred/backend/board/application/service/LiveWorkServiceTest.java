package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.LiveWorkUseCase;
import com.fathy.alfred.backend.board.application.port.in.LiveWorkUseCase.Report;
import com.fathy.alfred.backend.board.application.port.out.BoardNotificationPort;
import com.fathy.alfred.backend.board.domain.model.AgentStatus;
import com.fathy.alfred.backend.board.domain.model.LiveWork;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class LiveWorkServiceTest {

    private Instant now = Instant.parse("2026-10-13T09:00:00Z");
    private final Clock clock = new Clock() {
        @Override public ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(ZoneId zone) { return this; }
        @Override public Instant instant() { return now; }
    };
    private final List<LiveWork> signalled = new ArrayList<>();
    private final List<String> runnerSignals = new ArrayList<>();
    private final LiveWorkService service = new LiveWorkService(new BoardNotificationPort() {
        @Override public void changed(String project, String cycleId, String cardId, String what) { }
        @Override public void agentStatus(AgentStatus status) { }
        @Override public void liveWork(LiveWork work) { signalled.add(work); }
        @Override public void liveRunner(String project, String host, String kind) { runnerSignals.add(kind + ":" + project + "@" + host); }
    }, clock);

    private Report report(String id, LiveWork.State state, String... steps) {
        return new Report(id, "odeysys", 12, "acting on your answer", List.of(steps), null, state, null);
    }

    @Test
    void eachReportReplacesTheRunAndIsSignalledKeepingWhenItStarted() {
        service.report(report("r1", LiveWork.State.WORKING, "reading the card"));
        now = now.plusSeconds(3);
        LiveWork second = service.report(new Report("r1", "odeysys", 12, "acting on your answer",
                List.of("reading the card", "checking call #3"), "Got it - ", LiveWork.State.WORKING, null));

        assertThat(second.steps()).containsExactly("reading the card", "checking call #3");
        assertThat(second.draft()).isEqualTo("Got it - ");
        assertThat(second.startedAt()).isEqualTo(Instant.parse("2026-10-13T09:00:00Z"));
        assertThat(signalled).hasSize(2);
        assertThat(service.current("odeysys")).extracting(LiveWork::id).containsExactly("r1");
        assertThat(service.current("other")).isEmpty();
    }

    @Test
    void stopIsHandedBackOnTheRunnersNextReport() {
        service.report(report("r1", LiveWork.State.WORKING, "reading the card"));
        assertThat(service.stop("r1")).get().extracting(LiveWork::stop).isEqualTo(true);
        assertThat(service.report(report("r1", LiveWork.State.WORKING, "reading", "checking")).stop()).isTrue();
        assertThat(service.stop("nope")).isEmpty();
    }

    @Test
    void aRunThatStoppedReportingReadsAsFailedAndEndedRunsAreForgottenLater() {
        service.report(report("r1", LiveWork.State.WORKING, "reading"));
        service.report(report("r2", LiveWork.State.DONE, "reading", "replied"));
        now = now.plus(LiveWorkService.STALE).plusSeconds(1);
        assertThat(service.current(null)).extracting(LiveWork::id, LiveWork::state)
                .containsExactly(org.assertj.core.groups.Tuple.tuple("r1", LiveWork.State.FAILED), org.assertj.core.groups.Tuple.tuple("r2", LiveWork.State.DONE));
        now = now.plus(LiveWorkService.KEEP_ENDED);
        assertThat(service.current(null)).isEmpty();
    }

    @Test
    void stepsAndTheDraftAreBounded() {
        List<String> many = new ArrayList<>();
        for (int i = 0; i < 60; i++) {
            many.add("step " + i);
        }
        many.add("x".repeat(1000));
        LiveWork w = service.report(new Report("r1", "p", 1, "", many, "d".repeat(40_000), null, null));
        assertThat(w.steps()).hasSize(LiveWorkService.MAX_STEPS);
        assertThat(w.steps().get(w.steps().size() - 1)).hasSize(LiveWorkService.MAX_STEP + 1);
        assertThat(w.draft()).hasSize(LiveWorkService.MAX_DRAFT);
        assertThat(w.head()).isEqualTo("working");
        assertThat(w.state()).isEqualTo(LiveWork.State.WORKING);
        assertThat(Duration.between(w.startedAt(), w.updatedAt())).isZero();
    }

    @Test
    void aLongOutcomeIsCutToItsBoundNotRefusedAndAShortOneIsKept() {
        LiveWork cut = service.report(new Report("r1", "p", 1, "", List.of(), null, LiveWork.State.FAILED, "e".repeat(2000)));
        assertThat(cut.outcome()).hasSize(LiveWorkService.MAX_OUTCOME).endsWith("…");
        assertThat(service.report(new Report("r2", "p", 1, "", List.of(), null, LiveWork.State.DONE, "e".repeat(LiveWorkService.MAX_OUTCOME))).outcome())
                .isEqualTo("e".repeat(LiveWorkService.MAX_OUTCOME));
        assertThat(service.report(new Report("r3", "p", 1, "", List.of(), null, LiveWork.State.DONE, "replied")).outcome()).isEqualTo("replied");
        assertThat(service.report(new Report("r4", "p", 1, "", List.of(), null, LiveWork.State.DONE, null)).outcome()).isNull();
    }

    @Test
    void twoHundredStepsAreKeptAsTheLatestFortyEachCutToItsBound() {
        List<String> steps = new ArrayList<>();
        for (int i = 0; i < 200; i++) {
            steps.add(i == 199 ? "z".repeat(2000) : "step " + i);
        }

        LiveWork w = service.report(new Report("r1", "p", 1, "", steps, null, null, null));

        assertThat(w.steps()).hasSize(LiveWorkService.MAX_STEPS);
        assertThat(w.steps().get(0)).isEqualTo("step " + (200 - LiveWorkService.MAX_STEPS));
        assertThat(w.steps().get(w.steps().size() - 1)).hasSize(LiveWorkService.MAX_STEP + 1).endsWith("…");
    }

    @Test
    void theRunnersHeartbeatSaysWhereItAnswersFromUntilItStopsOrGoesQuiet() {
        assertThat(service.runner("odeysys")).isEmpty();
        service.beat("odeysys", "fathy-laptop", "sonnet", null, false);
        now = now.plusSeconds(40);
        service.beat("odeysys", "fathy-laptop", "sonnet", null, false);
        assertThat(service.runner("odeysys")).get().satisfies(r -> {
            assertThat(r.host()).isEqualTo("fathy-laptop");
            assertThat(r.kind()).isEqualTo("live");
            assertThat(r.startedAt()).isEqualTo(Instant.parse("2026-10-13T09:00:00Z"));
        });
        assertThat(runnerSignals).containsExactly("live:odeysys@fathy-laptop");
        now = now.plus(LiveWorkService.RUNNER_ALIVE).plusSeconds(1);
        assertThat(service.runner("odeysys")).isEmpty();
        service.beat("odeysys", "fathy-laptop", null, null, false);
        service.beat("odeysys", "fathy-laptop", null, null, true);
        assertThat(service.runner("odeysys")).isEmpty();
        assertThat(runnerSignals).containsExactly("live:odeysys@fathy-laptop", "live:odeysys@fathy-laptop", "live:odeysys@null");
        service.beat("", "fathy-laptop", null, null, false);
        assertThat(service.runner("odeysys")).get().extracting(r -> r.project()).isEqualTo("");
    }

    @Test
    void aRunnerHasAKindThatDefaultsToLiveAndIsSignalledWithIt() {
        assertThat(service.beat("odeysys", "laptop", null, null, false).kind()).isEqualTo("live");
        assertThat(service.beat("odeysys", "laptop", null, "  ", false).kind()).isEqualTo("live");
        assertThat(service.beat("odeysys", "laptop", null, "bogus", false).kind()).isEqualTo("live");
        LiveWorkUseCase.LiveRunner listen = service.beat("odeysys", "laptop", "haiku", "LISTEN", false);

        assertThat(listen.kind()).isEqualTo("listen");
        assertThat(runnerSignals).containsExactly("live:odeysys@laptop", "listen:odeysys@laptop");
        assertThat(service.runner("odeysys", "listen")).get().extracting(LiveWorkUseCase.LiveRunner::model).isEqualTo("haiku");
    }

    @Test
    void aListenRunnerBeatingBesideTheLiveRunnerNeverReplacesIt() {
        service.beat("odeysys", "laptop", null, "live", false);
        now = now.plusSeconds(20);
        service.beat("odeysys", "laptop", null, "listen", false);
        now = now.plusSeconds(20);
        service.beat("odeysys", "laptop", null, "live", false);
        service.beat("odeysys", "laptop", null, "listen", false);

        // the board is answered by the live runner, which kept its own start
        assertThat(service.runner("odeysys")).get().satisfies(r -> {
            assertThat(r.kind()).isEqualTo("live");
            assertThat(r.startedAt()).isEqualTo(Instant.parse("2026-10-13T09:00:00Z"));
        });
        assertThat(service.runner("odeysys", "listen")).get().extracting(LiveWorkUseCase.LiveRunner::startedAt)
                .isEqualTo(Instant.parse("2026-10-13T09:00:20Z"));
        assertThat(runnerSignals).containsExactly("live:odeysys@laptop", "listen:odeysys@laptop"); // no flip-flop signals

        // stopping the listen runner leaves the live one; stopping the live one leaves the listen one as the answer
        service.beat("odeysys", "laptop", null, "listen", true);
        assertThat(service.runner("odeysys", "listen")).isEmpty();
        assertThat(service.runner("odeysys")).get().extracting(LiveWorkUseCase.LiveRunner::kind).isEqualTo("live");
        service.beat("odeysys", "laptop", null, "listen", false);
        service.beat("odeysys", "laptop", null, "live", true);
        assertThat(service.runner("odeysys", "live")).isEmpty();
        assertThat(service.runner("odeysys")).get().extracting(LiveWorkUseCase.LiveRunner::kind).isEqualTo("listen");
    }

    @Test
    void aRunnerForEveryBoardAnswersAProjectOnlyOfItsOwnKind() {
        service.beat("", "laptop", null, "listen", false);

        assertThat(service.runner("odeysys", "listen")).get().extracting(LiveWorkUseCase.LiveRunner::project).isEqualTo("");
        assertThat(service.runner("odeysys", "live")).isEmpty();
        // a project runner of its own is not mistaken for the one for every board when it starts
        service.beat("odeysys", "desktop", null, "listen", false);
        assertThat(service.runner("odeysys", "listen")).get().extracting(LiveWorkUseCase.LiveRunner::host).isEqualTo("desktop");
        assertThat(runnerSignals).containsExactly("listen:@laptop", "listen:odeysys@desktop");
    }

    @Test
    void aLiveWorkReportIsProofThatTheRunnerIsAliveSoAQuietHeartbeatDoesNotHideIt() {
        service.beat("odeysys", "laptop", null, "live", false);
        // a long run: the runner cannot beat, but it reports its steps
        for (int i = 0; i < 4; i++) {
            now = now.plusSeconds(60);
            service.report(report("r1", LiveWork.State.WORKING, "step " + i));
        }

        assertThat(service.runner("odeysys")).get().satisfies(r -> {
            assertThat(r.startedAt()).isEqualTo(Instant.parse("2026-10-13T09:00:00Z"));
            assertThat(r.lastSeen()).isEqualTo(Instant.parse("2026-10-13T09:04:00Z"));
        });
        // and once the reports stop, the runner is gone after the same time as ever
        now = now.plus(LiveWorkService.RUNNER_ALIVE).plusSeconds(1);
        assertThat(service.runner("odeysys")).isEmpty();
    }

    @Test
    void aReportRefreshesTheRunnerForEveryBoardButNeverBringsADeadOneBack() {
        service.beat("", "laptop", null, "live", false);
        now = now.plusSeconds(90);
        service.report(report("r1", LiveWork.State.WORKING, "reading"));
        now = now.plusSeconds(90); // 180 s since the beat: alive only because of the report
        assertThat(service.runner("odeysys")).get().extracting(LiveWorkUseCase.LiveRunner::lastSeen)
                .isEqualTo(Instant.parse("2026-10-13T09:01:30Z"));

        now = now.plus(LiveWorkService.RUNNER_ALIVE).plusSeconds(1);
        assertThat(service.runner("odeysys")).isEmpty();
        service.report(report("r1", LiveWork.State.WORKING, "reading", "writing"));
        assertThat(service.runner("odeysys")).isEmpty();
        // and a report on a board nobody runs for creates nothing
        service.report(report("r2", LiveWork.State.DONE, "done"));
        assertThat(service.runner("other")).isEmpty();
        assertThat(runnerSignals).containsExactly("live:@laptop");
    }
}
