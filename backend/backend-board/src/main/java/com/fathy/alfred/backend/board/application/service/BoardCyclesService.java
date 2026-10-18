package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.BoardCyclesUseCase;
import com.fathy.alfred.backend.board.application.port.in.RetestUseCase;
import com.fathy.alfred.backend.board.application.port.out.BoardModelStorePort;
import com.fathy.alfred.backend.board.application.port.out.BoardNotificationPort;
import com.fathy.alfred.backend.board.application.port.out.BoardStorePort;
import com.fathy.alfred.backend.board.application.port.out.CycleControlPort;
import com.fathy.alfred.backend.board.application.port.out.CycleNamesPort;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.Board;
import com.fathy.alfred.backend.board.domain.model.BoardCycleLink;
import com.fathy.alfred.backend.board.domain.model.Card;
import com.fathy.alfred.backend.board.domain.model.RetestCheck;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;

/** The board's Cycles tab (specs/033) - read from the board's links and the cards' re-test checks, flags written here. */
@Service
public class BoardCyclesService implements BoardCyclesUseCase {

    private final BoardModelStorePort boards;
    private final BoardStorePort cards;
    private final RetestUseCase retests;
    private final BoardNotificationPort notifications;
    private final ObjectProvider<CycleNamesPort> names;
    private final ObjectProvider<CycleControlPort> cycles;

    public BoardCyclesService(BoardModelStorePort boards, BoardStorePort cards, RetestUseCase retests, BoardNotificationPort notifications,
                              BoardChangeFeed feed, ObjectProvider<CycleNamesPort> names, ObjectProvider<CycleControlPort> cycles) {
        this.boards = boards;
        this.cards = cards;
        this.retests = retests;
        // through the feed, so a waiting board_wait hears the change as it does every other board write
        this.notifications = feed.feeding(notifications);
        this.names = names;
        this.cycles = cycles;
    }

    @Override
    public Optional<List<CycleRow>> cycles(String boardId) {
        Optional<Board> board = boards.board(boardId);
        if (board.isEmpty()) {
            return Optional.empty();
        }
        List<CycleRow> rows = new ArrayList<>();
        for (BoardCycleLink link : boards.cycleLinks(boardId)) {
            List<TestedCard> tests = new ArrayList<>();
            for (String cardId : boards.cardsOfCycle(link.cycleId())) {
                cards.find(cardId).ifPresent(c -> tests.add(tested(c, link.cycleId())));
            }
            tests.sort(java.util.Comparator.comparingInt(TestedCard::number));
            List<String> others = boards.boardsOfCycle(link.cycleId()).stream().filter(b -> !b.equals(boardId)).toList();
            rows.add(new CycleRow(link.cycleId(), link.kind(), link.baseline(), link.archived(), link.relatedAt(), tests, others));
        }
        return Optional.of(rows);
    }

    private TestedCard tested(Card c, String cycleId) {
        Optional<RetestCheck> check = check(c.id(), cycleId);
        return new TestedCard(c.id(), c.number(), c.title(), c.status(), check.map(RetestCheck::verdict).orElse(null),
                check.map(RetestCheck::summary).orElse(null));
    }

    /** A check that throws (an older plan, a store hiccup) shows as "not checked", never as a failed tab. */
    private Optional<RetestCheck> check(String cardId, String cycleId) {
        try {
            return retests.checkCard(cardId, cycleId);
        } catch (RuntimeException e) {
            return Optional.empty();
        }
    }

    @Override
    public Optional<List<CycleVerdict>> timeline(String cardId) {
        Optional<Card> card = cards.find(cardId);
        if (card.isEmpty()) {
            return Optional.empty();
        }
        CycleControlPort control = cycles.getIfAvailable();
        Set<String> ids = new LinkedHashSet<>();
        String home = card.get().cycleId();
        boolean homeIsCycle = home != null && control != null && control.exists(home);
        if (homeIsCycle) {
            ids.add(home);
        }
        ids.addAll(boards.cardCycles(cardId));
        CycleNamesPort n = names.getIfAvailable();
        List<CycleVerdict> out = new ArrayList<>();
        for (String id : ids) {
            Optional<RetestCheck> check = check(cardId, id);
            out.add(new CycleVerdict(id, n == null ? id : n.nameOf(id).orElse(id), homeIsCycle && id.equals(home),
                    check.map(RetestCheck::verdict).orElse(null), check.map(r -> r.calls().size()).orElse(0),
                    check.map(RetestCheck::summary).orElse(null)));
        }
        return Optional.of(out);
    }

    private static String summariesOffKey(String boardId) {
        return "cycle-summaries-off:" + boardId;
    }

    @Override
    public boolean claudeSummaries(String boardId) {
        return !boards.done(summariesOffKey(boardId));
    }

    @Override
    public Outcome setClaudeSummaries(Actor actor, String boardId, boolean on) {
        if (actor == Actor.CLAUDE) {
            return Outcome.REFUSED;
        }
        Optional<Board> board = boards.board(boardId);
        if (board.isEmpty()) {
            return Outcome.NOT_FOUND;
        }
        if (on) {
            boards.unmark(summariesOffKey(boardId));
        } else {
            boards.markDone(summariesOffKey(boardId));
        }
        notifications.changed(board.get().project(), boardId, null, "boards");
        return Outcome.OK;
    }

    @Override
    public Outcome setFlags(Actor actor, String boardId, String cycleId, Flags flags) {
        if (actor == Actor.CLAUDE) {
            return Outcome.REFUSED;
        }
        Optional<Board> board = boards.board(boardId);
        if (board.isEmpty() || flags == null || !boards.setCycleFlags(boardId, cycleId, flags.baseline(), flags.archived())) {
            return Outcome.NOT_FOUND;
        }
        notifications.changed(board.get().project(), boardId, null, "boards");
        return Outcome.OK;
    }
}
