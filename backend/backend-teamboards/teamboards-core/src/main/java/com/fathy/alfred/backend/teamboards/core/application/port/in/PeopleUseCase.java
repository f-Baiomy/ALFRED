package com.fathy.alfred.backend.teamboards.core.application.port.in;

import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamBoardsPort.CardInfo;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.Me;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.PersonRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.SearchRow;

import java.util.List;
import java.util.Map;

/**
 * People pills and "Mine" (specs/028 US6, FR-085..089). A person is shown by name, never as a raw id; "me" is the
 * token's owner unless someone marked "This is me" (until the token changes).
 */
public interface PeopleUseCase {

    record TeamRef(String id, String name, String project) {
    }

    /** {@code assignedOpen}: open items assigned to them, counted live (null without a token). */
    record PersonCard(PersonRow person, boolean me, List<TeamRef> teams, Integer assignedOpen, List<CardInfo> cardsOwned,
                      List<CardInfo> cardsMentioning, List<String> boards) {
    }

    PersonCard person(String conn, String personId);

    /** One source of Mine: its count and its first rows (tracker items or cards). */
    record MineSource(String source, int count, List<SearchRow> items, List<CardInfo> cards, List<String> boards) {
    }

    /** The eight sources: assigned, created, changed, mentioned, followed (tracker); boards, cards owned, cards mentioning me. */
    record MineView(Me me, List<MineSource> sources, Map<String, String> failed) {
    }

    MineView mine(String conn);
}
