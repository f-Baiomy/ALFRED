package com.fathy.alfred.backend.boardbridge;

import com.fathy.alfred.backend.board.application.port.in.RecordForBoardUseCase;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.support.StaticListableBeanFactory;

import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/** Session Cycles' start asks the board slice (specs/027 FR-008); without it nothing is in the way. */
class BoardRecordingGuardAdapterTest {

    @Test
    void asksTheBoardsAndIsFreeWithoutThem() {
        RecordForBoardUseCase boards = mock(RecordForBoardUseCase.class);
        when(boards.recordingConflict("c1")).thenReturn(Optional.of("c2"));
        StaticListableBeanFactory f = new StaticListableBeanFactory();
        f.addBean("boards", boards);

        assertThat(new BoardRecordingGuardAdapter(f.getBeanProvider(RecordForBoardUseCase.class)).runningConflict("c1")).contains("c2");
        assertThat(new BoardRecordingGuardAdapter(new StaticListableBeanFactory().getBeanProvider(RecordForBoardUseCase.class))
                .runningConflict("c1")).isEmpty();
    }
}
