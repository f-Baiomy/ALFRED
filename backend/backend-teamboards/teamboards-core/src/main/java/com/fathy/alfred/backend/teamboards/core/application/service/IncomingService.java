package com.fathy.alfred.backend.teamboards.core.application.service;

import com.fathy.alfred.backend.teamboards.core.application.port.in.CardItemsUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.CardItemsUseCase.Markers;
import com.fathy.alfred.backend.teamboards.core.application.port.in.IncomingUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamException;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamBoardsPort;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamBoardsPort.Similar;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamChangeSignalPort;
import com.fathy.alfred.backend.teamboards.core.application.service.Live.Ctx;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.IncomingRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.IncomingSource;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.IncomingState;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.Who;
import com.fathy.alfred.backend.teamboards.spi.model.Item;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;

/**
 * Incoming from Azure (specs/028 US3). An arrival never makes a card by itself: it waits with its closest card, and
 * Claude's proposal waits for the user's Accept. A Feature or Epic (kind NONE) stays in Related items.
 */
@Service
public class IncomingService implements IncomingUseCase {

    static final int MATCH_AT = 40;

    private final Live live;
    private final TeamCachePort cache;
    private final TeamChangeSignalPort signals;
    private final ObjectProvider<TeamBoardsPort> boards;
    private final ObjectProvider<CardItemsUseCase> cardItems;
    private final TeamUseCase team;
    private final Clock clock = Clock.systemUTC();

    public IncomingService(Live live, TeamCachePort cache, TeamChangeSignalPort signals, ObjectProvider<TeamBoardsPort> boards,
                           ObjectProvider<CardItemsUseCase> cardItems, TeamUseCase team) {
        this.live = live;
        this.cache = cache;
        this.signals = signals;
        this.boards = boards;
        this.cardItems = cardItems;
        this.team = team;
    }

    private TeamBoardsPort port() {
        TeamBoardsPort p = boards.getIfAvailable();
        if (p == null) {
            throw TeamException.notFound("Boards are not wired in this Alfred");
        }
        return p;
    }

    @Override
    public List<IncomingRow> list(String boardId, boolean all) {
        return cache.incoming(boardId, all ? null : IncomingState.WAITING);
    }

    @Override
    public boolean arrive(String boardId, String conn, Item item, IncomingSource source) {
        if (!cache.cardLinksOfItem(conn, item.extId()).stream().filter(l -> boardId.equals(l.boardId())).toList().isEmpty()) {
            return false; // a card of this board already follows it
        }
        String matchCard = null;
        Integer score = null;
        TeamBoardsPort p = boards.getIfAvailable();
        if (p != null) {
            String text = item.fields().getOrDefault("System.Description", "");
            List<Similar> similar = p.similar(boardId, item.title(), text.length() > 2000 ? text.substring(0, 2000) : text, 3);
            if (!similar.isEmpty() && similar.get(0).score() >= MATCH_AT) {
                matchCard = similar.get(0).card().id();
                score = similar.get(0).score();
            }
        }
        boolean added = cache.arrive(new IncomingRow(boardId, conn, item.extId(), source, clock.instant(), item.rev(), item.type(), item.title(),
                matchCard, score, null, null, null, IncomingState.WAITING, null));
        if (added) {
            signals.board(boardId, conn, "incoming", Map.of("item", item.extId()));
        }
        return added;
    }

    @Override
    public IncomingRow add(Who who, String boardId, String conn, String item) {
        port().projectOf(boardId).orElseThrow(() -> TeamException.notFound("No board " + boardId));
        Ctx c = live.ctx(conn);
        Item i = live.item(c, BoardItemsService.idOf(item));
        arrive(boardId, conn, i, who == Who.CLAUDE ? IncomingSource.MCP : IncomingSource.HAND);
        return cache.incomingRow(boardId, conn, i.extId()).orElseThrow(() -> TeamException.notFound("Item " + i.extId() + " is not incoming"));
    }

    private IncomingRow waiting(String boardId, String conn, String item) {
        IncomingRow r = cache.incomingRow(boardId, conn, item).orElseThrow(() -> TeamException.notFound("Item " + item + " is not incoming here"));
        if (r.state() != IncomingState.WAITING) {
            throw TeamException.invalid("Item " + item + " was already " + r.state().name().toLowerCase(Locale.ROOT));
        }
        return r;
    }

    private static IncomingRow with(IncomingRow r, IncomingState state, Integer ignoredRev) {
        return new IncomingRow(r.boardId(), r.conn(), r.item(), r.source(), r.arrivedAt(), r.rev(), r.type(), r.title(), r.matchCard(), r.matchScore(),
                r.proposalAction(), r.proposalCard(), r.proposalReason(), state, ignoredRev);
    }

    @Override
    public String card(Who who, String boardId, String conn, String item, boolean markers) {
        if (who != Who.USER) {
            throw TeamException.userOnly("Claude proposes (team_propose_card); the user makes the card");
        }
        IncomingRow r = waiting(boardId, conn, item);
        String kind = team.kindOf(conn, r.type());
        if ("NONE".equals(kind)) {
            throw TeamException.invalid(r.type() + "s stay in Related items - change the type map in Settings to make cards of them");
        }
        Ctx c = live.ctx(conn);
        Item i = live.item(c, item);
        String body = i.fields().getOrDefault("System.Description", i.fields().getOrDefault("Microsoft.VSTS.TCM.ReproSteps", ""));
        String[] why = new String[1];
        Optional<String> cardId = port().createCard(boardId, false, kind, i.title() == null || i.title().isBlank() ? i.type() + " " + i.extId() : i.title(),
                body, why);
        if (cardId.isEmpty()) {
            throw TeamException.invalid(why[0] == null ? "The board did not take the card" : why[0]);
        }
        cardItems().link(Who.USER, cardId.get(), conn, i.extId(), markers ? Markers.ALL : Markers.NONE, null);
        cache.putIncoming(with(r, IncomingState.CARDED, null));
        signals.board(boardId, conn, "incoming", Map.of("item", item, "card", cardId.get()));
        return cardId.get();
    }

    private CardItemsUseCase cardItems() {
        CardItemsUseCase ci = cardItems.getIfAvailable();
        if (ci == null) {
            throw TeamException.notFound("Cards are not wired in this Alfred");
        }
        return ci;
    }

    @Override
    public void link(Who who, String boardId, String conn, String item, String cardId, boolean markers) {
        if (who != Who.USER) {
            throw TeamException.userOnly("Claude proposes (team_propose_card); the user links");
        }
        IncomingRow r = waiting(boardId, conn, item);
        port().card(cardId).orElseThrow(() -> TeamException.notFound("No card " + cardId));
        cardItems().link(Who.USER, cardId, conn, item, markers ? Markers.ALL : Markers.NONE, null);
        cache.putIncoming(with(r, IncomingState.LINKED, null));
        signals.board(boardId, conn, "incoming", Map.of("item", item, "card", cardId));
    }

    @Override
    public void ignore(Who who, String boardId, String conn, String item) {
        if (who != Who.USER) {
            throw TeamException.userOnly("Only the user ignores an incoming item");
        }
        IncomingRow r = waiting(boardId, conn, item);
        cache.putIncoming(with(r, IncomingState.IGNORED, r.rev()));
        signals.board(boardId, conn, "incoming", Map.of("item", item));
    }

    @Override
    public IncomingRow propose(Who who, String boardId, String conn, String item, String action, String cardId, String reason) {
        IncomingRow r = waiting(boardId, conn, item);
        String a = action == null ? "" : action.strip().toUpperCase(Locale.ROOT);
        if (!a.equals("NEW") && !a.equals("LINK")) {
            throw TeamException.invalid("action is NEW or LINK");
        }
        if (a.equals("LINK")) {
            if (cardId == null || cardId.isBlank()) {
                throw TeamException.invalid("A LINK proposal names the card");
            }
            port().card(cardId).orElseThrow(() -> TeamException.notFound("No card " + cardId));
        }
        if (reason == null || reason.isBlank() || reason.length() > 2000) {
            throw TeamException.invalid("A proposal says why, in at most 2000 characters");
        }
        IncomingRow next = new IncomingRow(r.boardId(), r.conn(), r.item(), r.source(), r.arrivedAt(), r.rev(), r.type(), r.title(), r.matchCard(),
                r.matchScore(), a, a.equals("LINK") ? cardId.strip() : null, reason.strip(), IncomingState.WAITING, null);
        cache.putIncoming(next);
        signals.board(boardId, conn, "incoming", Map.of("item", item));
        return next;
    }
}
