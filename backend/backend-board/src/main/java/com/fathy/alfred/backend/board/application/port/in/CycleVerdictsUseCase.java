package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.ItemVerdict.CallResult;

import java.time.Instant;
import java.util.List;

/**
 * One cycle shared by several boards (specs/027 US3, contracts/board-rest.md): for each of the cycle's calls, what every
 * related board's Acceptance items said about it, and the cards that mention it with their home board.
 */
public interface CycleVerdictsUseCase {

    int MAX_LIMIT = 2000;

    record ItemMark(String fileName, String key, CallResult result) {
    }

    record BoardMarks(String boardId, String name, List<ItemMark> items) {
    }

    record CardMark(String project, int number, String title, String home) {
    }

    record CallVerdicts(String callId, String method, String endpoint, Integer status, Double ms, Instant at, List<BoardMarks> boards,
                        List<CardMark> cards) {
    }

    record CycleVerdicts(String cycleId, List<BoardMarks> boards, List<CallVerdicts> calls) {
    }

    /**
     * The cycle's calls, newest first, at most {@code limit}. With {@code board}, only the calls that board's items name or
     * its cards mention. {@code boards} lists every related board (the columns), with no items.
     */
    CycleVerdicts verdicts(String cycleId, String board, int limit);
}
