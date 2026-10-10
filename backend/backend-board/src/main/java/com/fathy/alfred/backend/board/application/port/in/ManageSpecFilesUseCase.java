package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.SpecFile;
import com.fathy.alfred.backend.board.domain.model.SpecFileInfo;

import java.util.List;
import java.util.Optional;

/** The .md/.txt spec files of a cycle. A file of the same name is replaced (no versions). */
public interface ManageSpecFilesUseCase {

    int MAX_BYTES = 5 * 1024 * 1024;
    int MAX_FILES = 50;

    List<SpecFileInfo> specs(String cycleId);

    Optional<SpecFile> spec(String cycleId, String name);

    record SpecOutcome(CardChange.Outcome outcome, SpecFileInfo file, boolean replaced, String message) {
    }

    /** Refusals of name, type, size or count come back as INVALID with the message. */
    SpecOutcome put(Actor actor, String cycleId, String name, String content);

    CardChange.Outcome delete(Actor actor, String cycleId, String name);
}
