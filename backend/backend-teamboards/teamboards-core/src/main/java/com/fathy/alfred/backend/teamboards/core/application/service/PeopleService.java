package com.fathy.alfred.backend.teamboards.core.application.service;

import com.fathy.alfred.backend.teamboards.core.application.port.in.PeopleUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamException;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamException.Code;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamSearchUseCase.SearchIn;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamBoardsPort;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamBoardsPort.PersonCards;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.BoardItemRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.Me;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.PersonRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.SearchResult;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.SquadRow;
import com.fathy.alfred.backend.teamboards.spi.model.Item;
import com.fathy.alfred.backend.teamboards.spi.model.ItemQuery.Mine;
import com.fathy.alfred.backend.teamboards.spi.model.Person;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/** People and Mine (specs/028 US6). Tracker sources are live searches; board sources come through the bridge. */
@Service
public class PeopleService implements PeopleUseCase {

    static final int FIRST = 10;

    private final Live live;
    private final TeamCachePort cache;
    private final TeamUseCase team;
    private final TeamSearchService search;
    private final ObjectProvider<TeamBoardsPort> boards;

    public PeopleService(Live live, TeamCachePort cache, TeamUseCase team, TeamSearchService search, ObjectProvider<TeamBoardsPort> boards) {
        this.live = live;
        this.cache = cache;
        this.team = team;
        this.search = search;
        this.boards = boards;
    }

    @Override
    public PersonCard person(String conn, String personId) {
        live.stored(conn);
        PersonRow p = cache.person(conn, personId).orElseThrow(() -> TeamException.notFound("No such person " + personId));
        boolean me = team.me(conn).map(m -> m.person().extId() != null && m.person().extId().equals(p.extId())).orElse(false);
        List<TeamRef> teams = new ArrayList<>();
        for (SquadRow s : cache.squads(conn)) {
            if (s.members().stream().anyMatch(m -> p.extId().equals(m.extId()))) {
                teams.add(new TeamRef(s.extId(), s.name(), s.project()));
            }
        }
        Integer open = null;
        if (live.vault().token(conn).isPresent() && p.email() != null) {
            try {
                SearchResult r = search.search(conn, new SearchIn(null, null, null, true, null, null, null, p.email(), null, null, null, null, null,
                        null, 0, 1));
                open = r.total();
            } catch (TeamException e) {
                open = null;
            }
        }
        TeamBoardsPort port = boards.getIfAvailable();
        PersonCards cards = port == null ? new PersonCards(List.of(), List.of()) : port.cardsOf(conn, p.extId(), 50);
        return new PersonCard(p, me, teams, open, cards.owned(), cards.mentioning(), boardsOf(conn, p));
    }

    /** Boards whose main or card items are assigned to the person (from the saved copies). */
    List<String> boardsOf(String conn, PersonRow p) {
        Set<String> out = new LinkedHashSet<>();
        for (String board : cache.boardsWithItems()) {
            for (BoardItemRow r : cache.boardItems(board)) {
                if (!r.conn().equals(conn) || "REF".equals(r.role())) {
                    continue;
                }
                Optional<Item> copy = cache.copy(conn, r.item()).flatMap(Copies::item);
                Person a = copy.map(Item::assignedPerson).orElse(null);
                if (a != null && (p.extId().equals(a.extId()) || (p.email() != null && p.email().equalsIgnoreCase(a.email())))) {
                    out.add(board);
                    break;
                }
            }
        }
        return List.copyOf(out);
    }

    @Override
    public PeopleUseCase.MineView mine(String conn) {
        Me me = team.me(conn).orElseThrow(() -> new TeamException(Code.TOKEN_MISSING, "\"Mine\" needs to know who you are: enter your token first"));
        List<MineSource> sources = new ArrayList<>();
        Map<String, String> failed = new LinkedHashMap<>();
        boolean override = "OVERRIDE".equals(me.source());
        for (Mine m : Mine.values()) {
            if (override && (m == Mine.MENTIONED || m == Mine.FOLLOWED)) {
                failed.put(m.name(), "Only the token's owner has mentions and follows in the tracker");
                continue;
            }
            try {
                SearchResult r = search.search(conn, new SearchIn(null, null, null, true, null, null, null, null, null, null, null, null, Set.of(m), null,
                        0, FIRST));
                sources.add(new MineSource(m.name(), r.total(), r.items(), List.of(), List.of()));
            } catch (TeamException e) {
                if (e.code() == Code.TOKEN_MISSING || e.code() == Code.TOKEN_REJECTED) {
                    throw e;
                }
                failed.put(m.name(), e.getMessage());
            }
        }
        List<String> boardsMine = boardsOf(conn, me.person());
        sources.add(new MineSource("BOARDS", boardsMine.size(), List.of(), List.of(), boardsMine));
        TeamBoardsPort port = boards.getIfAvailable();
        PersonCards cards = port == null || me.person().extId() == null ? new PersonCards(List.of(), List.of())
                : port.cardsOf(conn, me.person().extId(), 50);
        sources.add(new MineSource("CARDS_OWNED", cards.owned().size(), List.of(), cards.owned(), List.of()));
        sources.add(new MineSource("CARDS_MENTIONING", cards.mentioning().size(), List.of(), cards.mentioning(), List.of()));
        return new PeopleUseCase.MineView(me, sources, failed);
    }
}
