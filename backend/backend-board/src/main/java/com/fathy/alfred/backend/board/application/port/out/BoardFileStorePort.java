package com.fathy.alfred.backend.board.application.port.out;

import com.fathy.alfred.backend.board.domain.model.BoardFile;

import java.util.List;
import java.util.Optional;

/** Files attached to cards and cycles (specs/017 R36). A card's go with it (ON DELETE CASCADE); a cycle's with the cycle. */
public interface BoardFileStorePort {

    void saveFile(BoardFile file);

    /** With its bytes. */
    Optional<BoardFile> findFile(String id);

    /** Without bytes, oldest first: a card's ({@code cardId}) or a cycle's ({@code cycleId}). */
    List<BoardFile> listFiles(String cardId, String cycleId);

    boolean deleteFile(String id);
}
