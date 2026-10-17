package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.CycleDeletePlanUseCase;
import com.fathy.alfred.backend.board.application.port.out.BoardModelStorePort;
import com.fathy.alfred.backend.board.application.port.out.BoardModelStorePort.CycleMention;
import com.fathy.alfred.backend.board.application.port.out.BoardNotificationPort;
import com.fathy.alfred.backend.board.domain.model.Board;
import com.fathy.alfred.backend.board.domain.model.BoardIds;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/**
 * Deleting a cycle keeps what boards mention (specs/027 FR-017): the cycle stays, as "kept from &lt;name&gt;", with only
 * the mentioned calls. Every mention keeps working as written - no board text is rewritten - and the calls' statements,
 * Redis commands and log lines stay because the mentioned copy keeps its live call (BoardMentions).
 */
@Service
public class CycleDeletePlanService implements CycleDeletePlanUseCase {

    private final BoardModelStorePort boards;
    private final BoardNotificationPort notifications;

    public CycleDeletePlanService(BoardModelStorePort boards, BoardNotificationPort notifications) {
        this.boards = boards;
        this.notifications = notifications;
    }

    @Override
    public Plan plan(String cycleId) {
        Map<String, Set<String>> calls = new LinkedHashMap<>();
        Map<String, Set<Integer>> cards = new LinkedHashMap<>();
        Set<String> all = new LinkedHashSet<>();
        for (CycleMention m : boards.mentionsInCycle(cycleId)) {
            String board = m.boardId() == null || m.boardId().isBlank() ? "" : m.boardId();
            calls.computeIfAbsent(board, k -> new LinkedHashSet<>()).add(m.callId());
            if (m.cardNumber() > 0) {
                cards.computeIfAbsent(board, k -> new TreeSet<>()).add(m.cardNumber());
            }
            all.add(m.callId());
        }
        List<BoardKeep> keep = new ArrayList<>();
        calls.forEach((id, ids) -> keep.add(new BoardKeep(id.isEmpty() ? null : id, nameOf(id), List.copyOf(ids),
                List.copyOf(cards.getOrDefault(id, Set.of())))));
        return new Plan(cycleId, keep, all);
    }

    @Override
    public void kept(String cycleId) {
        Set<String> mentioning = new LinkedHashSet<>();
        plan(cycleId).keep().forEach(k -> { if (k.boardId() != null) mentioning.add(k.boardId()); });
        for (String boardId : boards.boardsOfCycle(cycleId)) {
            if (!mentioning.contains(boardId)) {
                boards.unrelateCycle(boardId, cycleId);
            }
        }
        for (String boardId : mentioning) {
            boards.board(boardId).ifPresent(b -> boards.relateCycle(boardId, cycleId, com.fathy.alfred.backend.board.domain.model.Actor.USER,
                    java.time.Instant.now()));
        }
        notifications.changed(null, cycleId, null, "boards");
    }

    private String nameOf(String boardId) {
        if (boardId.isEmpty()) {
            return "no board";
        }
        return boards.board(boardId).map(Board::name)
                .orElse(BoardIds.isDefault(boardId) ? BoardIds.projectOfDefault(boardId) : boardId);
    }
}
