package com.fathy.alfred.backend.board.application.port.out;

import com.fathy.alfred.backend.board.domain.model.BoardImage;

import java.time.Instant;
import java.util.Optional;

/** Pictures in board texts (docs/board.md "Rich text"). */
public interface BoardImageStorePort {

    void saveImage(BoardImage image);

    Optional<BoardImage> findImage(String id);

    /** Removes the pictures no text ever showed, uploaded before {@code before}; returns how many. */
    int deleteUnattachedImages(Instant before);
}
