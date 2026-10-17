package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.RecordForBoardUseCase;
import com.fathy.alfred.backend.board.application.port.in.RelateCycleUseCase;
import com.fathy.alfred.backend.board.application.port.out.BoardModelStorePort;
import com.fathy.alfred.backend.board.application.port.out.CycleControlPort;
import com.fathy.alfred.backend.board.application.port.out.CycleNamesPort;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.Board;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.LocalDate;
import java.time.ZoneOffset;
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
    public synchronized Optional<Recording> record(Actor actor, String boardId, Kind kind, OnRunning onRunning) {
        Optional<Board> board = boards.board(boardId);
        if (board.isEmpty()) {
            return Optional.empty();
        }
        Optional<String> running = runningFor(Set.of(board.get().project()), null);
        OnRunning how = onRunning == null ? OnRunning.ASK : onRunning;
        if (running.isPresent()) {
            String id = running.get();
            if (boards.cyclesOf(boardId).contains(id)) {
                return Optional.of(new Recording(id, null, "already recording for this board"));
            }
            switch (how) {
                case ASK -> {
                    return Optional.of(new Recording(null, new Running(id, nameOf(id), boards.boardsOfCycle(id)),
                            "\"" + nameOf(id) + "\" is recording " + board.get().project() + ": join it or pause it and start a new one"));
                }
                case JOIN -> {
                    relations.relateCycle(actor, boardId, id);
                    return Optional.of(new Recording(id, null, "joined \"" + nameOf(id) + "\""));
                }
                case NEW -> { } // paused below, once the new cycle exists - a failed create leaves the running one recording
            }
        }
        String name = board.get().name() + (kind == Kind.RETEST ? " · re-test " : " · rec ") + LocalDate.now(clock.withZone(ZoneOffset.UTC));
        Optional<String> made = cyclePort().create(name);
        if (made.isEmpty()) {
            return Optional.of(new Recording(null, null, "Session cycles are not available here"));
        }
        running.ifPresent(id -> cyclePort().pause(id));
        relations.relateCycle(actor, boardId, made.get());
        return Optional.of(new Recording(made.get(), null, "started \"" + name + "\""));
    }
}
