package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.BoardImage;

import java.util.Optional;
import java.util.Set;

/** Pictures pasted or dropped into board texts (docs/board.md "Rich text"): kept in Alfred, served from it. */
public interface BoardImagesUseCase {

    Set<String> TYPES = Set.of("image/png", "image/jpeg", "image/gif", "image/webp");

    /** The stored picture's id, or why not ({@code error}). */
    record Saved(String id, String error) {
    }

    Saved save(String mime, byte[] data);

    Optional<BoardImage> image(String id);
}
