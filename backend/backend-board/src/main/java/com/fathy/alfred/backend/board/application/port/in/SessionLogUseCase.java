package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.SessionLogEntry;

import java.util.List;

/** Claude's session log on a cycle: one Did / Found / Next entry per skill run (specs/015 FR-12). */
public interface SessionLogUseCase {

    int MAX_TEXT = 16 * 1024;

    List<SessionLogEntry> log(String cycleId, int limit);

    /** Null when a part is missing or too long. */
    SessionLogEntry append(Actor actor, String cycleId, String skill, String did, String found, String next);
}
