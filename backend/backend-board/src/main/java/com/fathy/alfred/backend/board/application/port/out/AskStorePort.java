package com.fathy.alfred.backend.board.application.port.out;

import com.fathy.alfred.backend.board.domain.model.Ask;

import java.time.Instant;
import java.util.Optional;

/** Questions asked of Claude from the board (specs/017 R24, R38), in board.db. */
public interface AskStorePort {

    void saveAsk(Ask ask);

    Optional<Ask> findAsk(String id);

    /** Removes asks made before {@code before} (answered or not); returns how many. */
    int deleteAsksBefore(Instant before);
}
