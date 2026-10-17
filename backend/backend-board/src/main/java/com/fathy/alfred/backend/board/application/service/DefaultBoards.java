package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.out.BoardModelStorePort;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.Board;
import com.fathy.alfred.backend.board.domain.model.BoardIds;
import com.fathy.alfred.backend.board.domain.model.BoardState;

import java.time.Instant;

/** A project's default board (specs/027 FR-001), made the first time anything asks for it. */
final class DefaultBoards {

    private DefaultBoards() {
    }

    static Board ensure(BoardModelStorePort boards, String project, Instant now) {
        String id = BoardIds.defaultOf(project);
        return boards.board(id).orElseGet(() -> {
            Board b = new Board(id, project, project, true, BoardState.OPEN, null, now, now, Actor.USER);
            boards.putBoard(b);
            return b;
        });
    }
}
