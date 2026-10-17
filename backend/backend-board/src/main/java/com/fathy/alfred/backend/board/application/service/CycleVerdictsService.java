package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.CycleVerdictsUseCase;
import com.fathy.alfred.backend.board.application.port.out.BoardModelStorePort;
import com.fathy.alfred.backend.board.application.port.out.BoardStorePort;
import com.fathy.alfred.backend.board.application.port.out.CycleCallsPort;
import com.fathy.alfred.backend.board.application.port.out.RequirementStorePort;
import com.fathy.alfred.backend.board.domain.EndpointPattern;
import com.fathy.alfred.backend.board.domain.model.Board;
import com.fathy.alfred.backend.board.domain.model.CallBadge;
import com.fathy.alfred.backend.board.domain.model.Card;
import com.fathy.alfred.backend.board.domain.model.CycleCall;
import com.fathy.alfred.backend.board.domain.model.ItemEvidence;
import com.fathy.alfred.backend.board.domain.model.ItemVerdict.CallResult;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * The verdicts of one shared cycle (specs/027 US3): each related board judged the cycle's calls against its own items
 * (RequirementService keeps the results per board), so this only reads them back side by side - nothing is judged here.
 */
@Service
public class CycleVerdictsService implements CycleVerdictsUseCase {

    /** Results read back per item: a cycle's calls rarely pass this; older results are not shown. */
    private static final int RESULTS_PER_ITEM = 5000;

    private final BoardModelStorePort boards;
    private final RequirementStorePort requirements;
    private final BoardStorePort cards;
    private final CycleCallsPort cycleCalls;

    public CycleVerdictsService(BoardModelStorePort boards, RequirementStorePort requirements, BoardStorePort cards, CycleCallsPort cycleCalls) {
        this.boards = boards;
        this.requirements = requirements;
        this.cards = cards;
        this.cycleCalls = cycleCalls;
    }

    private record Item(String boardId, ItemEvidence evidence, Map<String, CallResult> results) {
    }

    @Override
    public CycleVerdicts verdicts(String cycleId, String board, int limit) {
        int max = Math.max(1, Math.min(limit, MAX_LIMIT));
        List<Board> related = boards.boardsOfCycle(cycleId).stream().map(boards::board).flatMap(Optional::stream).toList();
        List<BoardMarks> columns = related.stream().map(b -> new BoardMarks(b.id(), b.name(), List.of())).toList();

        List<Item> items = new ArrayList<>();
        for (Board b : related) {
            for (ItemEvidence ev : requirements.evidence(b.id())) {
                if (ev.manual()) {
                    continue;
                }
                Map<String, CallResult> byCall = new HashMap<>();
                for (RequirementStorePort.CallRow r : requirements.results(b.id(), ev.fileName(), ev.itemKey(), null, RESULTS_PER_ITEM)) {
                    byCall.putIfAbsent(r.callId(), r.result());
                }
                items.add(new Item(b.id(), ev, byCall));
            }
        }

        List<CycleCall> calls = cycleCalls.ofCycle(cycleId, max).stream().filter(c -> "in".equals(c.direction())).toList();
        Map<String, List<CallBadge>> badges = cards.badgesOfCalls(calls.stream().map(CycleCall::callId).toList());
        Map<String, String> homes = new HashMap<>();

        List<CallVerdicts> out = new ArrayList<>();
        for (CycleCall c : calls) {
            String endpoint = c.method() + " " + c.endpoint().replaceFirst("^\\S+\\s+", "");
            Map<String, List<ItemMark>> perBoard = new LinkedHashMap<>();
            boolean named = false;
            for (Item it : items) {
                boolean names = EndpointPattern.matches(it.evidence().endpoint(), endpoint);
                named |= names && it.boardId().equals(board);
                CallResult r = it.results().get(c.callId());
                if (r != null) {
                    perBoard.computeIfAbsent(it.boardId(), k -> new ArrayList<>())
                            .add(new ItemMark(it.evidence().fileName(), it.evidence().itemKey(), r));
                }
            }
            List<CardMark> cardMarks = new ArrayList<>();
            boolean mentioned = false;
            for (CallBadge badge : badges.getOrDefault(c.callId(), List.of())) {
                String home = homes.computeIfAbsent(badge.project() + "#" + badge.number(),
                        k -> cards.findByNumber(badge.project(), badge.number()).map(Card::boardId).orElse(""));
                mentioned |= home.equals(board);
                cardMarks.add(new CardMark(badge.project(), badge.number(), badge.title(), home.isEmpty() ? null : home));
            }
            if (board != null && !board.isBlank() && !named && !mentioned) {
                continue;
            }
            List<BoardMarks> marks = related.stream().filter(b -> perBoard.containsKey(b.id()))
                    .map(b -> new BoardMarks(b.id(), b.name(), perBoard.get(b.id()))).toList();
            out.add(new CallVerdicts(c.callId(), c.method(), c.path(), c.status(), c.durationMs(), c.at(), marks, cardMarks));
        }
        return new CycleVerdicts(cycleId, columns, out);
    }
}
