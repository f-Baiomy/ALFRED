package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.Board;
import com.fathy.alfred.backend.board.domain.model.BoardActivity;
import com.fathy.alfred.backend.board.domain.model.BoardOutcome;
import com.fathy.alfred.backend.board.domain.model.BoardState;
import com.fathy.alfred.backend.board.domain.model.BoardSummary;

import java.util.List;
import java.util.Optional;
import java.util.Set;

/** Boards as tasks (specs/027 US1): list, open, rename, state, delete, activity and Undo. */
public interface ManageBoardsUseCase {

    int MAX_LIMIT = 2000;

    /**
     * A new board: in {@code project}, related to {@code cycleIds} and to {@code relateTo}; {@code startRecording} makes a
     * first recording cycle. {@code askedIn} is required from Claude (FR-040): a user chat message id, or "terminal".
     */
    record NewBoard(String project, String name, List<String> cycleIds, String relateTo, boolean startRecording, String askedIn) {
        public NewBoard {
            cycleIds = cycleIds == null ? List.of() : List.copyOf(cycleIds);
        }
    }

    record Result(BoardOutcome outcome, Board board, String message) {
        public static Result of(BoardOutcome o, String message) {
            return new Result(o, null, message);
        }
    }

    List<BoardSummary> list(String project, Set<BoardState> states, String q, int limit);

    Optional<BoardSummary> get(String id);

    /** The project's default board, made on first use. */
    Board defaultBoard(String project);

    Result create(Actor actor, NewBoard board);

    Result update(Actor actor, String id, String name, BoardState state);

    Result delete(Actor actor, String id);

    List<BoardActivity> activity(String id, long after, int limit);

    /** Undoes one of Claude's changes on {@code boardId} (null: any board). */
    Result undo(Actor actor, String boardId, long activityId);
}
