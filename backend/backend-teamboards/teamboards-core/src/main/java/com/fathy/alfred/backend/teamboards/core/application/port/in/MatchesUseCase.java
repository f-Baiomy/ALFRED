package com.fathy.alfred.backend.teamboards.core.application.port.in;

import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.CardItem;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.MatchRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.Who;
import com.fathy.alfred.backend.teamboards.spi.model.Item;

import java.util.List;
import java.util.Map;

/**
 * Card matches (specs/030 D5, FR-015): for a board's cards that link no tracker item, the open Bug/Task/Issue items of
 * the main's tree that look like them - shared words and endpoint paths, found by code, no model. The user links one
 * ("Link") or rejects it ("Not this one", remembered for good); Claude may only write its own reason ({@link #why}).
 */
public interface MatchesUseCase {

    /** A proposed match with what the board knows of the item. */
    record Match(MatchRow row, String type, String title, String state) {
    }

    /** Re-reads the board's unlinked cards against its tree; the number of proposed matches afterwards. */
    default int propose(String boardId) {
        return propose(boardId, Map.of());
    }

    /**
     * As {@link #propose(String)}, with the items a sync just read live (by "conn/id"): their text (description, repro
     * steps) is compared, not only the title a reference keeps.
     */
    int propose(String boardId, Map<String, Item> read);

    /** The card's proposed matches, best first. */
    List<Match> matches(String cardId);

    /** The user links the card to the item (no bundle: the user's own link); the item leaves every other card's proposals. */
    List<CardItem> link(Who who, String cardId, String conn, String item);

    /** "Not this one": kept as REJECTED, never proposed again for this card. */
    List<Match> reject(Who who, String cardId, String conn, String item);

    /** Claude's (or the user's) reason replaces the code's. */
    List<Match> why(String cardId, String conn, String item, String why);
}
