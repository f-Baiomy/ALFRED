package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.Actor;

import java.util.List;
import java.util.Optional;

/**
 * Recording for a board (specs/027 FR-008, research R3). One project records into one cycle at a time: two cycles of the
 * boards of one project recording at once would each capture the other's calls.
 */
public interface RecordForBoardUseCase {

    enum OnRunning { ASK, JOIN, NEW }

    enum Kind { REC, RETEST }

    /** The cycle already recording the board's project, and the boards it is on. */
    record Running(String cycleId, String name, List<String> boards) {
    }

    /** {@code cycleId}: the cycle now recording for the board; {@code running}: set (and nothing done) when ASK met one. */
    record Recording(String cycleId, Running running, String message) {
        public boolean conflict() {
            return cycleId == null && running != null;
        }
    }

    /**
     * What a new cycle is for (specs/033): the cards a re-test tests (by number, on the board's project - the cycle is
     * named after them and related to each), a name that replaces the made one, and a description. All optional.
     */
    record Spec(List<Integer> cards, String name, String description) {
        public static final Spec NONE = new Spec(List.of(), null, null);

        public Spec {
            cards = cards == null ? List.of() : cards.stream().filter(java.util.Objects::nonNull).distinct().limit(50).toList();
        }
    }

    /** Empty when the board does not exist. */
    default Optional<Recording> record(Actor actor, String boardId, Kind kind, OnRunning onRunning) {
        return record(actor, boardId, kind, onRunning, Spec.NONE);
    }

    /** Empty when the board does not exist. Joining a running cycle ignores the spec's name and description. */
    Optional<Recording> record(Actor actor, String boardId, Kind kind, OnRunning onRunning, Spec spec);

    /** Another RECORDING cycle sharing a project with {@code cycleId} through their boards; empty for a cycle on no board. */
    Optional<String> recordingConflict(String cycleId);
}
