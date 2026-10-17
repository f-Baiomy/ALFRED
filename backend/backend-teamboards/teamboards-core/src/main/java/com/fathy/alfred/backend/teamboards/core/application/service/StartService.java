package com.fathy.alfred.backend.teamboards.core.application.service;

import com.fathy.alfred.backend.teamboards.core.application.port.in.BoardItemsUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.StartFromItemUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamException;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamBoardsPort;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort.PendingFile;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort.StartRow;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamChangeSignalPort;
import com.fathy.alfred.backend.teamboards.core.application.service.Live.Ctx;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.BoardItemRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.MappingKind;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.MappingRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.SquadRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.Who;
import com.fathy.alfred.backend.teamboards.spi.AttachmentsReader;
import com.fathy.alfred.backend.teamboards.spi.model.Attachment;
import com.fathy.alfred.backend.teamboards.spi.model.Item;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.Set;

/**
 * Start (specs/027 US8, FR-034; 028 FR-114): where the item's board goes (the mapping of its sprint, then squad, then
 * area, then project; else the user picks), one start per item, the waiting /alfred-setup message in that board's chat,
 * and - when the setup links the board - the item as the board's main.
 */
@Service
public class StartService implements StartFromItemUseCase {

    private static final Logger log = LoggerFactory.getLogger(StartService.class);
    static final String WAITING = "WAITING";
    static final String DONE = "DONE";

    private final Live live;
    private final TeamCachePort cache;
    private final TeamChangeSignalPort signals;
    private final ObjectProvider<TeamBoardsPort> boards;
    private final ObjectProvider<BoardItemsUseCase> boardItems;
    private final Clock clock;

    @Autowired
    public StartService(Live live, TeamCachePort cache, TeamChangeSignalPort signals, ObjectProvider<TeamBoardsPort> boards,
                        ObjectProvider<BoardItemsUseCase> boardItems) {
        this(live, cache, signals, boards, boardItems, Clock.systemUTC());
    }

    StartService(Live live, TeamCachePort cache, TeamChangeSignalPort signals, ObjectProvider<TeamBoardsPort> boards,
                 ObjectProvider<BoardItemsUseCase> boardItems, Clock clock) {
        this.live = live;
        this.cache = cache;
        this.signals = signals;
        this.boards = boards;
        this.boardItems = boardItems;
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

    /** The item from a board's copy, else live when a token is there. */
    Optional<Item> known(String conn, String extId) {
        Optional<Item> copy = cache.copy(conn, extId).flatMap(Copies::item);
        if (copy.isPresent()) {
            return copy;
        }
        return live.ctxIfLive(conn).map(c -> live.item(c, extId));
    }

    @Override
    public Target targetOf(String conn, String extId) {
        return known(conn, extId).map(i -> mapped(conn, i)).orElse(null);
    }

    /** Sprint, then squad, then area, then project (FR-034); then a squad the Teams view mapped to a project. */
    Target mapped(String conn, Item s) {
        List<MappingRow> all = cache.mappings(conn);
        String[][] order = {{MappingKind.SPRINT.name(), s.sprint()}, {MappingKind.SQUAD.name(), s.squad()}, {MappingKind.AREA.name(), s.area()},
                {MappingKind.PROJECT.name(), valueFor(MappingKind.PROJECT, conn, s)}};
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

    static MappingKind rememberAs(Item s) {
        if (s.squad() != null && !s.squad().isBlank()) return MappingKind.SQUAD;
        if (s.area() != null && !s.area().isBlank()) return MappingKind.AREA;
        return MappingKind.PROJECT;
    }

    static String valueFor(MappingKind kind, String conn, Item s) {
        return switch (kind) {
            case SQUAD -> s.squad();
            case AREA -> s.area();
            case SPRINT -> s.sprint();
            case PROJECT -> s.project() != null ? s.project() : projectOfArea(s.area()) == null ? conn : projectOfArea(s.area());
        };
    }

    /**
     * The start message: the command, then the item on one line. The title comes from the tracker (anyone can write it),
     * so it is flattened and capped - /alfred-setup reads the item itself through team_item.
     */
    static String setupText(String conn, Item s) {
        String title = s.title() == null ? "" : s.title().replaceAll("[\\r\\n\\t]+", " ").strip();
        if (title.length() > 120) {
            title = title.substring(0, 119) + "…";
        }
        return "/alfred-setup " + conn + "/" + s.extId() + "\n" + s.type() + " " + s.extId() + ": " + title;
    }

    @Override
    public StartResult start(String conn, String extId, Target target) {
        Ctx c = live.ctx(conn);
        Item s;
        try {
            s = live.item(c, extId);
        } catch (TeamException e) {
            if (e.code() == TeamException.Code.NOT_FOUND) {
                return StartResult.of(StartOutcome.NOT_FOUND, "Item " + extId + " is not in " + c.stored().name());
            }
            throw e;
        }
        Optional<String> mainOf = cache.boardsOfItem(conn, s.extId()).stream().filter(r -> "MAIN".equals(r.role())).map(BoardItemRow::boardId)
                .findFirst();
        if (mainOf.isPresent()) {
            return new StartResult(StartOutcome.ALREADY_STARTED, null, mainOf.get(), null, null,
                    "This item is the main of a board already - open it, or add the item to another board from Add", 0, null);
        }
        Optional<StartRow> waiting = cache.start(conn, s.extId()).filter(r -> WAITING.equals(r.state()));
        if (waiting.isPresent()) {
            String[] t = waiting.get().target().split("\\|", -1);
            return new StartResult(StartOutcome.WAITING, t[0], t.length > 1 && !t[1].isEmpty() ? t[1] : null, waiting.get().chatMessageId(), null,
                    "Already waiting for /alfred-setup", 0, null);
        }
        TeamBoardsPort port = boards.getIfAvailable();
        if (port == null) {
            return StartResult.of(StartOutcome.INVALID, "Boards are not wired in this Alfred");
        }
        Target where;
        if (target != null && target.project() != null && !target.project().isBlank()) {
            String project = target.project().strip();
            String board = target.boardId() == null || target.boardId().isBlank() ? null : target.boardId().strip();
            if (project.length() > 200) {
                return StartResult.of(StartOutcome.INVALID, "A project name is at most 200 characters");
            }
            if (board != null && !port.projectOf(board).map(project::equals).orElse(false)) {
                return StartResult.of(StartOutcome.INVALID, "Board " + board + " is not a board of " + project);
            }
            if (!port.projectExists(project)) {
                return StartResult.of(StartOutcome.INVALID, "Alfred has no project " + project);
            }
            where = new Target(project, board, target.remember());
            if (target.remember()) {
                MappingKind kind = rememberAs(s);
                cache.putMapping(conn, kind, valueFor(kind, conn, s), project, board);
                signals.changed(conn, "mappings");
            }
        } else {
            where = mapped(conn, s);
            if (where == null) {
                return new StartResult(StartOutcome.NEEDS_TARGET, null, null, null, null,
                        "Pick the Alfred project (and board) this item's board goes to", 0, null);
            }
        }
        String targetKey = where.project() + "|" + (where.boardId() == null ? "" : where.boardId());
        if (!cache.claimStart(new StartRow(conn, s.extId(), targetKey, null, WAITING, clock.instant()))) {
            Optional<StartRow> other = cache.start(conn, s.extId());
            return new StartResult(StartOutcome.WAITING, where.project(), where.boardId(), other.map(StartRow::chatMessageId).orElse(null), null,
                    "Already waiting for /alfred-setup", 0, null);
        }
        int fetched = fetchPending(c, s);
        Optional<Long> message;
        try {
            message = port.postStart(where.project(), where.boardId(), setupText(conn, s));
        } catch (RuntimeException e) {
            message = Optional.empty();
        }
        if (message.isEmpty()) {
            cache.deleteStart(conn, s.extId());
            cache.takePending(conn, s.extId());
            return StartResult.of(StartOutcome.INVALID, "Could not post the start to the board chat");
        }
        cache.putStart(new StartRow(conn, s.extId(), targetKey, message.get(), WAITING, clock.instant()));
        signals.changed(conn, "start");
        String who = port.whoAnswers(where.project(), where.boardId());
        return new StartResult(StartOutcome.WAITING, where.project(), where.boardId(), message.get(), null,
                who == null ? "Nobody is live for " + where.project() + ": start /alfred-live there (or open the board in a terminal); "
                        + "the setup waits until then" : null, fetched, who);
    }

    /** FR-037a: the attachments come down now and wait for the board (24 h at most). */
    private int fetchPending(Ctx c, Item s) {
        if (!(c.connector() instanceof AttachmentsReader r)) {
            return 0;
        }
        try {
            List<PendingFile> files = new ArrayList<>();
            for (Attachment a : live.call(c, () -> r.attachments(c.connection(), c.token(), s.extId(), true))) {
                if (a.data() != null) {
                    files.add(new PendingFile(a.name(), a.mime(), a.data().length, a.data()));
                }
            }
            cache.putPending(c.id(), s.extId(), files);
            return files.size();
        } catch (TeamException e) {
            log.info("Start of {} {}: attachments not fetched ({})", c.id(), s.extId(), e.code());
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
            return CancelOutcome.TAKEN;
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

    @Override
    public LinkResult link(com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.Who who, String boardId, String conn, String extId) {
        if (who == com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.Who.CLAUDE) {
            TeamBoardsPort port = boards.getIfAvailable();
            Optional<String> project = port == null ? Optional.empty() : port.projectOf(boardId);
            Optional<StartRow> start = cache.start(conn, extId).filter(r -> WAITING.equals(r.state()));
            if (start.isPresent() && start.get().target() != null) {
                String[] t = start.get().target().split("\\|", -1);
                boolean projectOk = project.isPresent() && project.get().equals(t[0]);
                boolean boardOk = t.length < 2 || t[1].isBlank() || t[1].equals(boardId);
                if (!projectOk || !boardOk) {
                    throw TeamException.userOnly("The start of " + extId + " was posted for " + (t.length > 1 && !t[1].isBlank() ? "board " + t[1]
                            : "project " + t[0]) + " - link it there");
                }
            }
            Optional<BoardItemRow> main = cache.main(boardId);
            if (main.isPresent() && !(main.get().conn().equals(conn) && main.get().item().equals(extId))) {
                throw TeamException.userOnly("Board " + boardId + " already has main item " + main.get().item() + " - only the user changes it");
            }
        }
        return link(boardId, conn, extId);
    }

    @Override
    public LinkResult link(String boardId, String conn, String extId) {
        TeamBoardsPort port = boards.getIfAvailable();
        BoardItemsUseCase bi = boardItems.getIfAvailable();
        if (port == null || bi == null || port.projectOf(boardId).isEmpty()) {
            throw TeamException.notFound("No board " + boardId);
        }
        bi.add(Who.USER, boardId, conn, extId, true, BoardItemsUseCase.MAX_REFS_ASKED, null);
        cache.start(conn, extId).ifPresent(r -> cache.putStart(new StartRow(r.conn(), r.extId(), r.target(), r.chatMessageId(), DONE, r.at())));
        List<String> attached = new ArrayList<>();
        List<String> notAttached = new ArrayList<>();
        Set<String> held = port.files(boardId);
        // each file leaves the store only once the board holds it; one refused never loses the others
        for (PendingFile f : cache.pending(conn, extId)) {
            if (held.contains(f.name())) {
                cache.deletePending(conn, extId, f.name());
                continue;
            }
            String why;
            try {
                why = port.attach(boardId, f.name(), f.data());
            } catch (RuntimeException e) {
                why = "not stored";
            }
            if (why == null) {
                attached.add(f.name());
                cache.deletePending(conn, extId, f.name());
            } else {
                notAttached.add(f.name() + " (" + why + ")");
            }
        }
        signals.changed(conn, "start");
        return new LinkResult(attached, notAttached);
    }

    @Override
    public LinkResult fetchAttachments(String boardId) {
        TeamBoardsPort port = boards.getIfAvailable();
        BoardItemRow main = cache.main(boardId).orElseThrow(() -> TeamException.notFound("Board " + boardId + " has no main item"));
        if (port == null) {
            throw TeamException.notFound("Boards are not wired in this Alfred");
        }
        Ctx c = live.ctx(main.conn());
        AttachmentsReader r = live.cap(c, AttachmentsReader.class, "read attachments");
        Set<String> held = port.files(boardId);
        List<String> attached = new ArrayList<>();
        List<String> notAttached = new ArrayList<>();
        for (Attachment a : live.call(c, () -> r.attachments(c.connection(), c.token(), main.item(), true))) {
            if (held.contains(a.name())) {
                continue;
            }
            if (a.data() == null) {
                notAttached.add(a.name() + " (over the size limit - open it in the tracker)");
                continue;
            }
            String why = port.attach(boardId, a.name(), a.data());
            if (why == null) attached.add(a.name()); else notAttached.add(a.name() + " (" + why + ")");
        }
        return new LinkResult(attached, notAttached);
    }
}
