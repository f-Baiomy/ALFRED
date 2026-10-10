package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.BoardChanges;

/**
 * What changed after a cursor (Claude resuming, or listening while the user works), and a way to be told when the next
 * change happens - the wait is driven by the same signal as /ws/board, never by a timer.
 */
public interface BoardChangesUseCase {

    int MAX_LIMIT = 500;

    /**
     * {@code cursor}: from a previous answer; "now" for the current position; "claude" for just after Claude's last
     * history entry (on {@code project}'s board, or anywhere when project is null); null/blank for the start.
     * {@code actor}: only entries by them (null: everyone). {@code project}/{@code cycleId}: only that board (null: all).
     */
    BoardChanges changes(String cursor, String project, String cycleId, Actor actor, int limit);

    /** Called once on the next board change; returns a handle that cancels it. */
    AutoCloseable onNextChange(Runnable listener);
}
