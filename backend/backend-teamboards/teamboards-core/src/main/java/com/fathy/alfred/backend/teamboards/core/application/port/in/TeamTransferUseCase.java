package com.fathy.alfred.backend.teamboards.core.application.port.in;

import java.util.List;
import java.util.Map;

/**
 * A board's tracker side in a board export (specs/028 FR-112): its related items (with the full copies Alfred keeps),
 * its cards' links, what waits in Incoming and its watch rules - as plain records, one per line of the export, and read
 * back on import onto the board's id here. A record naming a connection this Alfred does not have is skipped.
 */
public interface TeamTransferUseCase {

    /** The kinds of record, as the export's {@code record} field. */
    String ITEM = "team-item";
    String CARD_LINK = "team-card-link";
    /** A match the user rejected for a card (specs/030): kept so it is never proposed again. Proposals are not carried. */
    String CARD_MATCH = "team-card-match";
    String INCOMING = "team-incoming";
    String RULE = "team-watch-rule";

    /** One record: its kind and its fields (strings, numbers, booleans, nested maps). */
    record TeamRecord(String kind, Map<String, Object> fields) {
    }

    /** Everything the board holds of the tracker; card links carry {@code cardId} (the exporter turns it into a number). */
    List<TeamRecord> export(String boardId);

    /**
     * Writes one record onto board {@code boardId} (and card {@code cardId} for a card link). False when it was skipped:
     * an unknown kind, a connection not here, or a field missing.
     */
    boolean importRecord(String kind, String boardId, String cardId, Map<String, Object> fields);
}
