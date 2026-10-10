package com.fathy.alfred.backend.boardbridge;

import com.fathy.alfred.backend.board.application.port.in.CycleRemovedUseCase;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class BoardCycleRemovedAdapterTest {

    @Test
    void aDeletedCycleReachesTheBoard() {
        List<String> removed = new ArrayList<>();
        CycleRemovedUseCase board = removed::add;

        new BoardCycleRemovedAdapter(board).cycleRemoved("c-1");

        assertThat(removed).containsExactly("c-1");
    }
}
