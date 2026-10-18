package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.RecordForBoardUseCase;
import com.fathy.alfred.backend.board.application.port.in.RelateCycleUseCase;
import com.fathy.alfred.backend.board.application.port.out.BoardModelStorePort;
import com.fathy.alfred.backend.board.application.port.out.CycleControlPort;
import com.fathy.alfred.backend.board.application.port.out.CycleNamesPort;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.application.port.out.BoardStorePort;
import com.fathy.alfred.backend.board.domain.model.Board;
import com.fathy.alfred.backend.board.domain.model.Card;
import com.fathy.alfred.backend.board.domain.model.CycleNaming;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;

/** Records for a board: joins the cycle already recording its project, or pauses it and starts a new one (specs/027 FR-008). */
@Service
public class RecordForBoardService implements RecordForBoardUseCase {

    private final BoardModelStorePort boards;
    private final RelateCycleUseCase relations;
    private final ObjectProvider<CycleControlPort> cycles;
    private final ObjectProvider<CycleNamesPort> names;
    private final Clock clock;

    @org.springframework.beans.factory.annotation.Autowired
    public RecordForBoardService(BoardModelStorePort boards, RelateCycleUseCase relations, ObjectProvider<CycleControlPort> cycles,
                                 ObjectProvider<CycleNamesPort> names) {
        this(boards, relations, cycles, names, Clock.systemUTC());
    }

    RecordForBoardService(BoardModelStorePort boards, RelateCycleUseCase relations, ObjectProvider<CycleControlPort> cycles,
                          ObjectProvider<CycleNamesPort> names, Clock clock) {
        this.boards = boards;
        this.relations = relations;
        this.cycles = cycles;
        this.names = names;
        this.clock = clock;
    }

    private BoardStorePort cards;

    /** The cards a re-test names (specs/033); without it a re-test is named after the board. */
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    void setCards(BoardStorePort cards) {
        this.cards = cards;
    }

    private CycleControlPort cyclePort() {
        CycleControlPort p = cycles.getIfAvailable();
        return p == null ? new CycleControlPort() { } : p;
    }

    private String nameOf(String cycleId) {
        CycleNamesPort n = names.getIfAvailable();
        return n == null ? cycleId : n.nameOf(cycleId).filter(s -> !s.isBlank()).orElse(cycleId);
    }

    /** The projects a cycle records for: those of the boards it is related to. */
    private Set<String> projectsOf(String cycleId) {
        return boards.boardsOfCycle(cycleId).stream().map(boards::board).flatMap(Optional::stream).map(Board::project)
                .collect(Collectors.toSet());
    }

    private Optional<String> runningFor(Set<String> projects, String except) {
        if (projects.isEmpty()) {
            return Optional.empty();
        }
        for (String id : cyclePort().recordingCycles()) {
            if (!id.equals(except) && projectsOf(id).stream().anyMatch(projects::contains)) {
                return Optional.of(id);
            }
        }
        return Optional.empty();
    }

    @Override
    public Optional<String> recordingConflict(String cycleId) {
        return runningFor(projectsOf(cycleId), cycleId);
    }

    @Override
    public synchronized Optional<Recording> record(Actor actor, String boardId, Kind kind, OnRunning onRunning, Spec spec) {
        Spec what = spec == null ? Spec.NONE : spec;
        Optional<Board> board = boards.board(boardId);
        if (board.isEmpty()) {
            return Optional.empty();
        }
        Optional<String> running = runningFor(Set.of(board.get().project()), null);
        OnRunning how = onRunning == null ? OnRunning.ASK : onRunning;
        if (running.isPresent()) {
            String id = running.get();
            if (boards.cyclesOf(boardId).contains(id)) {
                relateCards(board.get(), id, what);
                return Optional.of(new Recording(id, null, "already recording for this board"));
            }
            switch (how) {
                case ASK -> {
                    return Optional.of(new Recording(null, new Running(id, nameOf(id), boards.boardsOfCycle(id)),
                            "\"" + nameOf(id) + "\" is recording " + board.get().project() + ": join it or pause it and start a new one"));
                }
                case JOIN -> {
                    relations.relateCycle(actor, boardId, id);
                    relateCards(board.get(), id, what);
                    return Optional.of(new Recording(id, null, "joined \"" + nameOf(id) + "\""));
                }
                case NEW -> { } // paused below, once the new cycle exists - a failed create leaves the running one recording
            }
        }
        List<Card> tested = testedCards(board.get(), what);
        String name = what.name() != null && !what.name().isBlank() ? what.name().strip()
                : kind == Kind.RETEST || !tested.isEmpty()
                ? CycleNaming.retest(tested.stream().map(c -> new CycleNaming.Tested(c.number(), c.title())).toList(), board.get().name(), clock.instant())
                : CycleNaming.recording(board.get().name(), clock.instant());
        if (name.length() > CycleNaming.MAX) {
            name = name.substring(0, CycleNaming.MAX);
        }
        Optional<String> made = cyclePort().create(name);
        if (made.isEmpty()) {
            return Optional.of(new Recording(null, null, "Session cycles are not available here"));
        }
        running.ifPresent(id -> cyclePort().pause(id));
        relations.relateCycle(actor, boardId, made.get());
        boards.setCycleKind(boardId, made.get(), kind == Kind.RETEST || !tested.isEmpty() ? "RETEST" : "REC");
        for (Card c : tested) {
            boards.relateCardCycle(c.id(), made.get());
        }
        if (what.description() != null && !what.description().isBlank()) {
            cyclePort().describe(made.get(), what.description());
        }
        return Optional.of(new Recording(made.get(), null, "started \"" + name + "\""));
    }

    /** The spec's cards that exist on the board's project, in the order given. */
    private List<Card> testedCards(Board board, Spec spec) {
        List<Card> out = new ArrayList<>();
        if (cards == null) {
            return out;
        }
        for (Integer n : spec.cards()) {
            cards.findByNumber(board.project(), n).ifPresent(out::add);
        }
        return out;
    }

    private void relateCards(Board board, String cycleId, Spec spec) {
        for (Card c : testedCards(board, spec)) {
            boards.relateCardCycle(c.id(), cycleId);
        }
    }
}
