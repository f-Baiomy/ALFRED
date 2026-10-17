package com.fathy.alfred.backend.board.domain.model;

import java.util.List;

/**
 * A board in the picker and in GET /board/boards: the board, how many cards are homed there, the cycles and boards
 * related to it, and the work item it was opened from (null when none).
 */
public record BoardSummary(Board board, int cards, List<String> cycleIds, List<String> boardIds, String linkedItem) {

    public BoardSummary {
        cycleIds = cycleIds == null ? List.of() : List.copyOf(cycleIds);
        boardIds = boardIds == null ? List.of() : List.copyOf(boardIds);
    }
}
