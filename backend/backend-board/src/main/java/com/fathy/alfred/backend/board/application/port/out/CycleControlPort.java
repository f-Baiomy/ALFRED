package com.fathy.alfred.backend.board.application.port.out;

import java.util.List;
import java.util.Optional;

/**
 * What a board asks of the session cycles it relates to (specs/027 research R3): make a cycle (it starts recording),
 * start or pause one, whether one records, and which record now. Implemented in backend-app/boardbridge over the
 * session-cycles use cases; the default does nothing, so the board slice runs without it in tests.
 */
public interface CycleControlPort {

    /** A new cycle, recording; its id, or empty when cycles cannot be made here. */
    default Optional<String> create(String name) {
        return Optional.empty();
    }

    default boolean start(String cycleId) {
        return false;
    }

    default boolean pause(String cycleId) {
        return false;
    }

    default boolean recording(String cycleId) {
        return false;
    }

    /** Ids of every cycle recording now. */
    default List<String> recordingCycles() {
        return List.of();
    }

    /** Writes the cycle's description (specs/033); false when cycles cannot be written here. */
    default boolean describe(String cycleId, String description) {
        return false;
    }

    /** False when no such cycle exists. */
    default boolean exists(String cycleId) {
        return false;
    }
}
