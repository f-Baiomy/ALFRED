package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.application.port.in.SnippetsUseCase.Result;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.BoardFile;

import java.util.List;
import java.util.Optional;

/**
 * Files attached to a card or a cycle (specs/017 R36): at most 10 MB, of the types {@link BoardFile#TYPES} names, 50 in one
 * place. Claude may attach files and remove the ones it attached; the user may do anything.
 */
public interface BoardFilesUseCase {

    /** Exactly one of {@code cardId} / {@code cycleId}; a cycle's file needs its {@code project}. Answers the file without its bytes. */
    Result<BoardFile> attach(Actor actor, String cardId, String cycleId, String project, String name, byte[] data);

    Result<List<BoardFile>> files(String cardId, String cycleId);

    /** With its bytes. */
    Optional<BoardFile> file(String id);

    Result<Void> remove(Actor actor, String id);
}
