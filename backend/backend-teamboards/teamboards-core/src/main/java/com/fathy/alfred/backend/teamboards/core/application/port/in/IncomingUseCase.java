package com.fathy.alfred.backend.teamboards.core.application.port.in;

import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.IncomingRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.IncomingSource;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.Who;
import com.fathy.alfred.backend.teamboards.spi.model.Item;

import java.util.List;

/**
 * "Incoming from Azure" (specs/028 US3, FR-053..058): tracker items that arrived for a board - from its tree, a watch
 * rule, the service hook, by hand or through the MCP - wait without a card until the user picks New card, Link to
 * card… or Ignore. Claude only proposes (team_propose_card); an ignored item comes back only with a newer rev.
 */
public interface IncomingUseCase {

    List<IncomingRow> list(String boardId, boolean all);

    /** An arrival; false when it is already there (or ignored at this rev). The close match is found here. */
    boolean arrive(String boardId, String conn, Item item, IncomingSource source);

    /** By hand or by the MCP: the item is read live and arrives. */
    IncomingRow add(Who who, String boardId, String conn, String item);

    /** New card from the entry (USER, or accepting Claude's proposal); the new card's id. */
    String card(Who who, String boardId, String conn, String item, boolean markers);

    void link(Who who, String boardId, String conn, String item, String cardId, boolean markers);

    void ignore(Who who, String boardId, String conn, String item);

    /** Claude's proposal for an entry: NEW (a card) or LINK (to {@code cardId}), with its reason. */
    IncomingRow propose(Who who, String boardId, String conn, String item, String action, String cardId, String reason);
}
