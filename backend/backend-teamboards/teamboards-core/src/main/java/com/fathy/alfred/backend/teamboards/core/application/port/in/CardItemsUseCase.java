package com.fathy.alfred.backend.teamboards.core.application.port.in;

import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.CardItem;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.WriteBundle;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.Who;
import com.fathy.alfred.backend.teamboards.spi.model.NewItem;

import java.util.List;

/**
 * Cards and tracker items, many to many (specs/028 US3, FR-050..055, FR-075): the link lives in Alfred at once for the
 * user (with a pill in the card's description and a full copy of the item); the markers in Azure (hyperlink back,
 * comment, tag {@code alfred}) are a bundle the user approves. As Claude, the link itself is a bundle step.
 */
public interface CardItemsUseCase {

    /** Which markers to propose writing in the tracker for a new link. */
    record Markers(boolean hyperlink, boolean comment, boolean tag) {
        public static final Markers NONE = new Markers(false, false, false);
        public static final Markers ALL = new Markers(true, true, true);
    }

    record LinkResult(List<CardItem> items, WriteBundle bundle) {
    }

    List<CardItem> items(String cardId);

    LinkResult link(Who who, String cardId, String conn, String item, Markers markers, String askedIn);

    /** Creates an item in the tracker from the card (always a bundle: CREATE, then the link and the markers). */
    WriteBundle create(Who who, String cardId, String conn, NewItem item, Markers markers);

    /** Unlinks (USER); a cleanup bundle (unhyperlink, untag when no other card links it, a comment) waits for approval. */
    LinkResult unlink(Who who, String cardId, String conn, String item);

    /** The Alfred side of a link, after approval or for the user: link row, copy, pill, the board's card item. */
    List<CardItem> linkInAlfred(String cardId, String conn, String item, String by);
}
