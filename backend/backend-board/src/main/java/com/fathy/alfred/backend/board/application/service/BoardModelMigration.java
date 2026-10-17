package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.out.BoardModelStorePort;
import com.fathy.alfred.backend.board.application.port.out.CycleControlPort;
import com.fathy.alfred.backend.board.application.port.out.CycleNamesPort;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.Board;
import com.fathy.alfred.backend.board.domain.model.BoardActivity;
import com.fathy.alfred.backend.board.domain.model.BoardState;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * The first start after specs/027 (data-model.md "Migration", FR-019): every project gets its default board (its cards
 * and project chat were already there - {@code board_id} defaults to it and the project chat is stored as ""); every task
 * key that held a brief, spec files, evidence or a chat becomes a board with that same id (research R1), named after its
 * cycle, related to it and home to the cards found in it; every other cycle cards name is related to its project's
 * default board. Runs once (board_meta {@value #STEP}); a second start changes nothing.
 */
@Service
public class BoardModelMigration {

    static final String STEP = "boards_v1";
    private static final Logger log = LoggerFactory.getLogger(BoardModelMigration.class);

    private final BoardModelStorePort boards;
    private final CycleNamesPort names;
    private final ObjectProvider<CycleControlPort> cycles;
    private final Clock clock;

    public BoardModelMigration(BoardModelStorePort boards, CycleNamesPort names, ObjectProvider<CycleControlPort> cycles) {
        this(boards, names, cycles, Clock.systemUTC());
    }

    BoardModelMigration(BoardModelStorePort boards, CycleNamesPort names, ObjectProvider<CycleControlPort> cycles, Clock clock) {
        this.boards = boards;
        this.names = names;
        this.cycles = cycles;
        this.clock = clock;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void onReady() {
        try {
            migrate();
        } catch (RuntimeException e) {
            // Loud, and retried on the next start: until then cards and chats stay on the default boards.
            log.error("Board model migration failed: {}", e.toString(), e);
        }
    }

    /** One pass; a no-op once done. Returns how many boards it made from cycles. */
    synchronized int migrate() {
        if (boards.done(STEP)) {
            return 0;
        }
        Instant now = clock.instant();
        List<String> projects = boards.knownProjects();
        for (String project : projects) {
            defaultBoard(project, now);
        }
        int made = 0;
        for (String key : boards.briefedTaskKeys()) {
            var existing = boards.board(key);
            if (existing.isPresent()) {
                // a pass that stopped half-way: finish homing the cards of the board it had made
                if (existing.get().migratedFrom() != null) {
                    boards.homeCardsOfTaskKey(key, existing.get().project());
                }
                continue;
            }
            // a key with only a brief or spec files names no project: the only project is safe, a guess among several is not
            String project = boards.projectOfTaskKey(key).orElse(projects.size() == 1 ? projects.get(0) : "");
            if (project.isEmpty()) {
                log.warn("Board migration: task {} names no project; left without a board", key);
                continue;
            }
            defaultBoard(project, now);
            String cycleName = names.nameOf(key).filter(n -> !n.isBlank()).orElse(null);
            String name = cycleName == null ? "Task " + shortId(key) : cycleName;
            boards.putBoard(new Board(key, project, name, false, BoardState.OPEN, name, now, now, Actor.USER));
            if (cycleName != null || cycleExists(key)) {
                boards.relateCycle(key, key, Actor.USER, now);
            }
            int moved = boards.homeCardsOfTaskKey(key, project);
            boards.addActivity(new BoardActivity(0, key, Actor.USER, BoardActivity.Kind.MIGRATED,
                    "made from cycle \"" + name + "\": its brief, spec files, Acceptance items, chat and " + moved + " card(s)", null, now, null),
                    Integer.MAX_VALUE);
            made++;
        }
        for (Map.Entry<String, List<String>> e : boards.originCyclesByProject().entrySet()) {
            String project = e.getKey();
            if (project == null || project.isBlank()) {
                continue;
            }
            String home = defaultBoard(project, now).id();
            for (String cycleId : e.getValue()) {
                if (boards.board(cycleId).isEmpty() && cycleExists(cycleId)) {
                    boards.relateCycle(home, cycleId, Actor.USER, now);
                }
            }
        }
        boards.markDone(STEP);
        log.info("Board model migration: {} project default board(s), {} board(s) made from cycles", projects.size(), made);
        return made;
    }

    private Board defaultBoard(String project, Instant now) {
        return DefaultBoards.ensure(boards, project, now);
    }

    private boolean cycleExists(String cycleId) {
        CycleControlPort p = cycles.getIfAvailable();
        return p != null ? p.exists(cycleId) : names.nameOf(cycleId).isPresent();
    }

    private static String shortId(String id) {
        return id.length() > 8 ? id.substring(0, 8) : id;
    }
}
