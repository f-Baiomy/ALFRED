package com.fathy.alfred.backend.board.application.port.out;

import java.util.Map;

/**
 * Where a board import hands the records of the board's tracker side (specs/028 FR-112: {@code team-*} records - related
 * items with their copies, card links, Incoming, watch rules) once the board and its cards have their ids here. The Team
 * slice writes them; without it they are skipped like any record this reader does not know.
 */
public interface TeamRecordsImportPort {

    /** False when the record was skipped (a connection not here, a field missing). */
    boolean imported(String kind, String boardId, String cardId, Map<String, Object> fields);
}
