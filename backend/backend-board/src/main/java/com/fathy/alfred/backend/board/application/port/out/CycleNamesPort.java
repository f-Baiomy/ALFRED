package com.fathy.alfred.backend.board.application.port.out;

import java.util.Optional;

/**
 * A session cycle's name, empty when no such cycle exists here - implemented in backend-app/boardbridge with the
 * session-cycles slice. The board chat export names each cycle chat's cycle, and an import whose cycle is not here
 * lands under the project chat marked with that name (specs/022 edge case).
 */
public interface CycleNamesPort {

    Optional<String> nameOf(String cycleId);
}
