package com.fathy.alfred.backend.teamboards.core.application.service;

import com.fathy.alfred.backend.teamboards.core.application.port.in.StartFromItemUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamBoardsPort;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort.PendingFile;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort.StartRow;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort.StoredConnection;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamChangeSignalPort;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ItemSummary;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.MappingKind;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.MappingRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.SquadRow;
import com.fathy.alfred.backend.teamboards.spi.AttachmentsReader;
import com.fathy.alfred.backend.teamboards.spi.Connector;
import com.fathy.alfred.backend.teamboards.spi.ProviderException;
import com.fathy.alfred.backend.teamboards.spi.model.Attachment;
import com.fathy.alfred.backend.teamboards.spi.model.Token;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Start (specs/027 US8, FR-034): where the item's board goes (the mapping of its sprint, then squad, then area, then
 * project; else the user picks), one start per item, and the waiting /alfred-setup message in that board's chat.
 */
@Service
public class StartService implements StartFromItemUseCase {

    private static final Logger log = LoggerFactory.getLogger(StartService.class);
    static final String WAITING = "WAITING";
    static final String DONE = "DONE";

    private final Map<String, Connector> connectors;
    private final TeamCachePort cache;
    private final TeamChangeSignalPort signals;
    private final ObjectProvider<TeamBoardsPort> boards;
    private final Clock clock;

    @Autowired
    public StartService(List<Connector> connectors, TeamCachePort cache, TeamChangeSignalPort signals, ObjectProvider<TeamBoardsPort> boards) {
        this(connectors, cache, signals, boards, Clock.systemUTC());
    }

    StartService(List<Connector> connectors, TeamCachePort cache, TeamChangeSignalPort signals, ObjectProvider<TeamBoardsPort> boards, Clock clock) {
        this.connectors = CachedItems.byKind(connectors);
        this.cache = cache;
        this.signals = signals;
        this.boards = boards;
        this.clock = clock;
    }

    /** The project an area path starts with ("Odeysys\\Payments" -> "Odeysys"). */
    static String projectOfArea(String area) {
        if (area == null || area.isBlank()) {
            return null;
        }
        int cut = area.indexOf('\\');
        return cut < 0 ? area : area.substring(0, cut);
    }

    @Override
    public Target targetOf(String conn, String extId) {
        return cache.summary(conn, extId).map(s -> mapped(conn, s)).orElse(null);
    }

    /** Sprint, then squad, then area, then project (FR-034); then a squad the Squads view mapped to a project. */
    Target mapped(String conn, ItemSummary s) {
        List<MappingRow> all = cache.mappings(conn);
        String[][] order = {{MappingKind.SPRINT.name(), s.sprint()}, {MappingKind.SQUAD.name(), s.squad()}, {MappingKind.AREA.name(), s.area()},
                {MappingKind.PROJECT.name(), valueFor(MappingKind.PROJECT, s)}};
        for (String[] o : order) {
            if (o[1] == null || o[1].isBlank()) {
                continue;
            }
            for (MappingRow m : all) {
                if (m.kind().name().equals(o[0]) && m.extValue().equalsIgnoreCase(o[1])) {
                    return new Target(m.alfredProject(), m.alfredBoard(), false);
                }
            }
        }
        if (s.squad() != null) {
            for (SquadRow q : cache.squads(conn)) {
                if (q.alfredProject() != null && q.name().equalsIgnoreCase(s.squad())) {
                    return new Target(q.alfredProject(), null, false);
                }
            }
        }
        return null;
    }

    /** What a remembered target is saved as: the most specific thing the item has. */
    static MappingKind rememberAs(ItemSummary s) {
        if (s.squad() != null && !s.squad().isBlank()) return MappingKind.SQUAD;
        if (s.area() != null && !s.area().isBlank()) return MappingKind.AREA;
        return MappingKind.PROJECT;
    }

    static String valueFor(MappingKind kind, ItemSummary s) {
        return switch (kind) {
            case SQUAD -> s.squad();
            case AREA -> s.area();
            case SPRINT -> s.sprint();
            case PROJECT -> projectOfArea(s.area()) == null ? s.conn() : projectOfArea(s.area());
        };
    }

    /**
     * The start message: the command, then the item on one line. The title comes from the tracker (anyone can write it),
     * so it is flattened and capped - /alfred-setup reads the item itself through team_item.
     */
    static String setupText(String conn, ItemSummary s) {
        String title = s.title() == null ? "" : s.title().replaceAll("[\\r\\n\\t]+", " ").strip();
        if (title.length() > 120) {
            title = title.substring(0, 119) + "…";
        }
        return "/alfred-setup " + conn + "/" + s.extId() + "\n" + s.type() + " " + s.extId() + ": " + title;
    }

    @Override
    public StartResult start(String conn, String extId, Target target, Token token) {
        Optional<StoredConnection> c = cache.connection(conn);
        Optional<ItemSummary> found = cache.summary(conn, extId);
        if (c.isEmpty() || found.isEmpty()) {
            return StartResult.of(StartOutcome.NOT_FOUND, "Item " + extId + " is not in the cache yet: Refresh the Team tab first");
        }
        ItemSummary s = found.get();
        Optional<String> linked = cache.linkOfItem(conn, extId).map(l -> l.alfredBoard());
        if (linked.isPresent()) {
            return new StartResult(StartOutcome.ALREADY_STARTED, null, linked.get(), null, null, "This item already has a board", 0);
        }
        Optional<StartRow> waiting = cache.start(conn, extId).filter(r -> WAITING.equals(r.state()));
        if (waiting.isPresent()) {
            String[] t = waiting.get().target().split("\\|", -1);
            return new StartResult(StartOutcome.WAITING, t[0], t.length > 1 && !t[1].isEmpty() ? t[1] : null, waiting.get().chatMessageId(), null,
                    "Already waiting for /alfred-setup", 0);
        }
        TeamBoardsPort port = boards.getIfAvailable();
        if (port == null) {
            return StartResult.of(StartOutcome.INVALID, "Boards are not wired in this Alfred");
        }
        Target where;
        if (target != null && target.project() != null && !target.project().isBlank()) {
            String project = target.project().strip();
            String board = target.boardId() == null || target.boardId().isBlank() ? null : target.boardId().strip();
            if (board != null && !port.projectOf(board).map(project::equals).orElse(false)) {
                return StartResult.of(StartOutcome.INVALID, "Board " + board + " is not a board of " + project);
            }
            if (project.length() > 200) {
                return StartResult.of(StartOutcome.INVALID, "A project name is at most 200 characters");
            }
            if (!port.projectExists(project)) {
                return StartResult.of(StartOutcome.INVALID, "Alfred has no project " + project);
            }
            where = new Target(project, board, target.remember());
            if (target.remember()) {
                MappingKind kind = rememberAs(s);
                cache.putMapping(conn, kind, valueFor(kind, s), project, board);
                signals.changed(conn, "mappings");
            }
        } else {
            where = mapped(conn, s);
            if (where == null) {
                return new StartResult(StartOutcome.NEEDS_TARGET, null, null, null, null,
                        "Pick the Alfred project (and board) this item's board goes to", 0);
            }
        }
        // claim first (one start per item, two clicks at once included), fetch, and only then post: the runner may take
        // the message at once, and its team_link must find the start and its files
        String targetKey = where.project() + "|" + (where.boardId() == null ? "" : where.boardId());
        if (!cache.claimStart(new StartRow(conn, extId, targetKey, null, WAITING, clock.instant()))) {
            Optional<StartRow> other = cache.start(conn, extId);
            return new StartResult(StartOutcome.WAITING, where.project(), where.boardId(), other.map(StartRow::chatMessageId).orElse(null), null,
                    "Already waiting for /alfred-setup", 0);
        }
        int fetched = token == null || token.blank() ? 0 : fetchPending(c.get(), s, token);
        Optional<Long> message;
        try {
            message = port.postStart(where.project(), where.boardId(), setupText(conn, s));
        } catch (RuntimeException e) {
            message = Optional.empty();
        }
        if (message.isEmpty()) {
            cache.deleteStart(conn, extId);
            cache.takePending(conn, extId);
            return StartResult.of(StartOutcome.INVALID, "Could not post the start to the board chat");
        }
        cache.putStart(new StartRow(conn, extId, targetKey, message.get(), WAITING, clock.instant()));
        signals.changed(conn, "start");
        String who = port.whoAnswers(where.project(), where.boardId());
        return new StartResult(StartOutcome.WAITING, where.project(), where.boardId(), message.get(), null,
                who == null ? "Nobody is live for " + where.project() + ": start /alfred-live there (or open the board in a terminal); "
                        + "the setup waits until then" : null, fetched, who);
    }

    /** FR-037a: with the viewer's token, the attachments come down now and wait for the board (24 h at most). */
    private int fetchPending(StoredConnection c, ItemSummary s, Token token) {
        if (!(connectors.get(c.kind()) instanceof AttachmentsReader r)) {
            return 0;
        }
        try {
            List<PendingFile> files = new ArrayList<>();
            for (Attachment a : r.attachments(CachedItems.connection(c), token, s.extId(), true)) {
                if (a.data() != null) {
                    files.add(new PendingFile(a.name(), a.mime(), a.data().length, a.data()));
                }
            }
            cache.putPending(c.id(), s.extId(), files);
            return files.size();
        } catch (ProviderException e) {
            log.info("Start of {} {}: attachments not fetched ({})", c.id(), s.extId(), e.kind()); // the board lists them to fetch later
            return 0;
        } catch (RuntimeException e) {
            log.warn("Start of {} {}: attachments not fetched ({})", c.id(), s.extId(), e.getClass().getSimpleName());
            return 0;
        }
    }

    @Override
    public CancelOutcome cancel(String conn, String extId) {
        Optional<StartRow> row = cache.start(conn, extId).filter(r -> WAITING.equals(r.state()));
        if (row.isEmpty()) {
            return CancelOutcome.NOT_WAITING;
        }
        TeamBoardsPort port = boards.getIfAvailable();
        if (port != null && row.get().chatMessageId() != null && !port.withdrawStart(row.get().chatMessageId())) {
            return CancelOutcome.TAKEN; // the setup has begun: it finishes and links the board
        }
        cache.deleteStart(conn, extId);
        cache.takePending(conn, extId);
        signals.changed(conn, "start");
        return CancelOutcome.CANCELLED;
    }

    @Override
    public boolean isWaiting(String conn, String extId) {
        return cache.start(conn, extId).filter(r -> WAITING.equals(r.state())).isPresent();
    }

    @Override
    public boolean askedByUser(String askedIn) {
        TeamBoardsPort port = boards.getIfAvailable();
        return port != null && askedIn != null && !askedIn.isBlank() && port.askedBy(askedIn.strip());
    }
}
