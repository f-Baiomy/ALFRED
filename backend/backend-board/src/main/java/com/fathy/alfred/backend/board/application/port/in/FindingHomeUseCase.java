package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.Board;

import java.util.List;

/** Where a listen's finding goes when its cycle is on several boards (specs/027 US3, research R5). Read-only. */
public interface FindingHomeUseCase {

    enum Kind { EVIDENCE, HOME, ASK }

    /** {@code card}: the number to add evidence to (EVIDENCE); {@code boardId}: the home (HOME); {@code options}: ASK. */
    record Home(Kind kind, Integer card, String boardId, List<Board> options, String reason) {
    }

    Home resolve(String project, String cycleId, String endpoint, String signature, String startedFor);
}
