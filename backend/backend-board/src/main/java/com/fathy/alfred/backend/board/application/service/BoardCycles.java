package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.out.BoardModelStorePort;

import java.util.List;

/**
 * The session cycles a task key stands for (specs/027 research R1 amendment): a board's related cycles, or - for an old
 * caller still passing a cycle id that names no board - that cycle alone. A migrated board's id is its old cycle's id and
 * it is related to that cycle, so both paths agree for it.
 */
final class BoardCycles {

    private BoardCycles() {
    }

    static List<String> of(BoardModelStorePort boards, String taskKey) {
        if (taskKey == null || taskKey.isBlank()) {
            return List.of();
        }
        return boards.board(taskKey).isPresent() ? boards.cyclesOf(taskKey) : List.of(taskKey);
    }
}
