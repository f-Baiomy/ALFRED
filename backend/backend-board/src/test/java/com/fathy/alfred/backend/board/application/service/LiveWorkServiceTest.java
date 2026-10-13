package com.fathy.alfred.backend.board.application.service;

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
    private final LiveWorkService service = new LiveWorkService(new BoardNotificationPort() {
        @Override public void changed(String project, String cycleId, String cardId, String what) { }
        @Override public void agentStatus(AgentStatus status) { }
        @Override public void liveWork(LiveWork work) { signalled.add(work); }
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
}
