package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.ManageBoardsUseCase.NewBoard;
import com.fathy.alfred.backend.board.application.port.in.RecordForBoardUseCase.Kind;
import com.fathy.alfred.backend.board.application.port.in.RecordForBoardUseCase.OnRunning;
import com.fathy.alfred.backend.board.application.port.in.RecordForBoardUseCase.Recording;
import com.fathy.alfred.backend.board.domain.model.Actor;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/** One project records into one cycle at a time (specs/027 FR-008, research R3). */
class RecordForBoardTest {

    @TempDir
    Path dir;
    BoardFixture f;
    String refund;
    String sprint;

    @BeforeEach
    void open() {
        f = new BoardFixture(dir);
        refund = f.boards.create(Actor.USER, new NewBoard("odeysys", "Refund", List.of(), null, true, null)).board().id();
        sprint = f.boards.create(Actor.USER, new NewBoard("odeysys", "Sprint", List.of(), null, false, null)).board().id();
    }

    @AfterEach
    void close() throws Exception {
        f.close();
    }

    private String refundCycle() {
        return f.boards.cyclesOf(refund).get(0);
    }

    @Test
    void askReturnsTheRunningCycleAndDoesNothing() {
        Recording r = f.record.record(Actor.USER, sprint, Kind.REC, OnRunning.ASK).orElseThrow();
        assertThat(r.conflict()).isTrue();
        assertThat(r.running().cycleId()).isEqualTo(refundCycle());
        assertThat(r.running().boards()).containsExactly(refund);
        assertThat(f.boards.cyclesOf(sprint)).isEmpty();
    }

    @Test
    void joinRelatesTheRunningCycle() {
        Recording r = f.record.record(Actor.USER, sprint, Kind.REC, OnRunning.JOIN).orElseThrow();
        assertThat(r.cycleId()).isEqualTo(refundCycle());
        assertThat(f.boards.cyclesOf(sprint)).containsExactly(refundCycle());
        assertThat(f.record.recordingConflict(refundCycle())).isEmpty();
    }

    @Test
    void newPausesTheRunningOneAndStartsAnother() {
        String old = refundCycle();
        Recording r = f.record.record(Actor.USER, sprint, Kind.RETEST, OnRunning.NEW).orElseThrow();
        assertThat(r.cycleId()).isNotEqualTo(old);
        assertThat(f.recordingHere).containsExactly(r.cycleId());
        assertThat(f.cycleNames.get(r.cycleId())).startsWith("Sprint · re-test ");
    }

    @Test
    void aCycleOnNoBoardIsNeverInTheWay() {
        f.cyclesHere.add("loose");
        f.recordingHere.add("loose");
        assertThat(f.record.recordingConflict("loose")).isEmpty();
        assertThat(f.record.recordingConflict("other-loose")).isEmpty();
    }

    @Test
    void anotherProjectsRecordingIsNotAConflict() {
        String crm = f.boards.create(Actor.USER, new NewBoard("crm", "CRM", List.of(), null, false, null)).board().id();
        assertThat(f.record.record(Actor.USER, crm, Kind.REC, OnRunning.ASK).orElseThrow().conflict()).isFalse();
        assertThat(f.recordingHere).hasSize(2);
    }

    @Test
    void aSecondBoardWithAFirstRecordingPausesTheProjectsRunningOne() {
        String old = refundCycle();
        String third = f.boards.create(Actor.USER, new NewBoard("odeysys", "Third", List.of(), null, true, null)).board().id();
        assertThat(f.recordingHere).doesNotContain(old).containsExactly(f.boards.cyclesOf(third).get(0));
    }
}
