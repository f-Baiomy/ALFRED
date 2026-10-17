package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.FindingHomeUseCase;
import com.fathy.alfred.backend.board.application.port.out.BoardModelStorePort;
import com.fathy.alfred.backend.board.application.port.out.BoardStorePort;
import com.fathy.alfred.backend.board.application.port.out.RequirementStorePort;
import com.fathy.alfred.backend.board.domain.EndpointPattern;
import com.fathy.alfred.backend.board.domain.model.Board;
import com.fathy.alfred.backend.board.domain.model.BoardIds;
import com.fathy.alfred.backend.board.domain.model.Card;
import com.fathy.alfred.backend.board.domain.model.ItemEvidence;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.Set;

/**
 * Where a finding of one listen goes when its cycle is shared by several boards (specs/027 US3, research R5):
 * <ol>
 *   <li>an open card of a related board with the same signature takes it as evidence;</li>
 *   <li>else the one related board whose Acceptance items name the endpoint is its home;</li>
 *   <li>with several such boards Claude asks, with one option per board, in the starting board's chat;</li>
 *   <li>with none, the board the listen was started for, else the cycle's only board, else its project's default board.</li>
 * </ol>
 * Done and archived boards take no findings. Nothing here writes: the caller adds the card or the evidence.
 */
@Service
public class ListenHomeResolver implements FindingHomeUseCase {

    private final BoardModelStorePort boards;
    private final BoardStorePort cards;
    private final RequirementStorePort requirements;

    public ListenHomeResolver(BoardModelStorePort boards, BoardStorePort cards, RequirementStorePort requirements) {
        this.boards = boards;
        this.cards = cards;
        this.requirements = requirements;
    }

    @Override
    public Home resolve(String project, String cycleId, String endpoint, String signature, String startedFor) {
        List<Board> open = boards.boardsOfCycle(cycleId).stream().map(boards::board).flatMap(Optional::stream)
                .filter(Board::open).toList();
        Set<String> openIds = Set.copyOf(open.stream().map(Board::id).toList());

        if (signature != null && !signature.isBlank() && project != null) {
            for (Card c : cards.openBySignature(project, List.of(signature)).getOrDefault(signature, List.of())) {
                if (openIds.contains(c.boardId())) {
                    return new Home(Kind.EVIDENCE, c.number(), c.boardId(), List.of(), "the same finding is already #" + c.number());
                }
            }
        }

        List<Board> naming = new ArrayList<>();
        if (endpoint != null && !endpoint.isBlank()) {
            for (Board b : open) {
                for (ItemEvidence ev : requirements.evidence(b.id())) {
                    if (!ev.manual() && EndpointPattern.matches(ev.endpoint(), endpoint)) {
                        naming.add(b);
                        break;
                    }
                }
            }
        }
        if (naming.size() == 1) {
            return new Home(Kind.HOME, null, naming.get(0).id(), List.of(), "its requirements name " + endpoint);
        }
        if (naming.size() > 1) {
            return new Home(Kind.ASK, null, null, naming, "the requirements of " + naming.size() + " boards name " + endpoint);
        }

        if (startedFor != null && !startedFor.isBlank() && boards.board(startedFor).map(Board::open).orElse(false)) {
            return new Home(Kind.HOME, null, startedFor, List.of(), "the listen was started for it");
        }
        if (open.size() == 1) {
            return new Home(Kind.HOME, null, open.get(0).id(), List.of(), "the cycle's only open board");
        }
        String fallback = open.stream().filter(Board::isDefault).map(Board::id).findFirst()
                .orElse(project == null || project.isBlank() ? null : BoardIds.defaultOf(project));
        return new Home(Kind.HOME, null, fallback, List.of(), "no board names it: the project's default board");
    }
}
