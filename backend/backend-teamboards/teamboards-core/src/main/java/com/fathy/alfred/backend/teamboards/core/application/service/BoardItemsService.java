package com.fathy.alfred.backend.teamboards.core.application.service;

import com.fathy.alfred.backend.teamboards.core.application.port.in.AzureWritesUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.AzureWritesUseCase.NewBundle;
import com.fathy.alfred.backend.teamboards.core.application.port.in.BoardItemsUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.IncomingUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamException;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamException.Code;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamBoardsPort;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamBoardsPort.CardInfo;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamChangeSignalPort;
import com.fathy.alfred.backend.teamboards.core.application.service.Live.Ctx;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.BoardItemRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.CardLinkRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.FieldDiff;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.IncomingSource;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ItemCopyRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.StepKind;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.SyncRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.Who;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.WriteStep;
import com.fathy.alfred.backend.teamboards.spi.ItemReader;
import com.fathy.alfred.backend.teamboards.spi.TreeReader;
import com.fathy.alfred.backend.teamboards.spi.model.Comment;
import com.fathy.alfred.backend.teamboards.spi.model.Item;
import com.fathy.alfred.backend.teamboards.spi.model.TreeRef;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.CARD;
import static com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.MAIN;
import static com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.REF;

/**
 * A board's Related items (specs/028 US2, R5). One main per board (a unique index); its tree is read live and kept as
 * references; the main and the card items keep a full copy, synced field by field. Nothing here writes to the tracker.
 */
@Service
public class BoardItemsService implements BoardItemsUseCase {

    private static final Logger log = LoggerFactory.getLogger(BoardItemsService.class);
    static final Duration SYNC_EVERY = Duration.ofMinutes(1);
    /** An item named by its tracker URL: ".../_workitems/edit/123", "...?workitem=123", or "AB#123". */
    static final Pattern URL_ID = Pattern.compile("(?:_workitems/edit/|[?&]workitem=|/workItems/|AB#)(\\d+)", Pattern.CASE_INSENSITIVE);

    private final Live live;
    private final TeamCachePort cache;
    private final TeamChangeSignalPort signals;
    private final ObjectProvider<TeamBoardsPort> boards;
    private final ObjectProvider<AzureWritesUseCase> writes;
    private final ObjectProvider<IncomingUseCase> incoming;
    private final ObjectProvider<TeamUseCase> team;
    private final Clock clock;
    private final Map<String, Instant> lastSync = new ConcurrentHashMap<>();
    private final Set<String> syncing = ConcurrentHashMap.newKeySet();
    private final ExecutorService background = Executors.newFixedThreadPool(2, r -> {
        Thread t = new Thread(r, "team-sync");
        t.setDaemon(true);
        return t;
    });

    @Autowired
    public BoardItemsService(Live live, TeamCachePort cache, TeamChangeSignalPort signals, ObjectProvider<TeamBoardsPort> boards,
                             ObjectProvider<AzureWritesUseCase> writes, ObjectProvider<IncomingUseCase> incoming, ObjectProvider<TeamUseCase> team) {
        this(live, cache, signals, boards, writes, incoming, team, Clock.systemUTC());
    }

    BoardItemsService(Live live, TeamCachePort cache, TeamChangeSignalPort signals, ObjectProvider<TeamBoardsPort> boards,
                      ObjectProvider<AzureWritesUseCase> writes, ObjectProvider<IncomingUseCase> incoming, ObjectProvider<TeamUseCase> team,
                      Clock clock) {
        this.live = live;
        this.cache = cache;
        this.signals = signals;
        this.boards = boards;
        this.writes = writes;
        this.incoming = incoming;
        this.team = team;
        this.clock = clock;
    }

    // ---------------------------------------------------------------------------------------------------------- read

    private void board(String boardId) {
        TeamBoardsPort p = boards.getIfAvailable();
        if (boardId == null || boardId.isBlank() || p == null || p.projectOf(boardId).isEmpty()) {
            throw TeamException.notFound("No board " + boardId);
        }
    }

    @Override
    public View list(String boardId) {
        List<BoardItemRow> rows = cache.boardItems(boardId);
        Map<String, List<String>> cards = new HashMap<>();
        for (CardLinkRow l : cache.cardLinksOfBoard(boardId)) {
            cards.computeIfAbsent(l.conn() + "/" + l.item(), k -> new ArrayList<>()).add(l.cardId());
        }
        ItemRow main = null;
        List<ItemRow> items = new ArrayList<>();
        for (BoardItemRow r : rows) {
            Optional<ItemCopyRow> copy = MAIN.equals(r.role()) || CARD.equals(r.role()) ? cache.copy(r.conn(), r.item()) : Optional.empty();
            ItemRow row = new ItemRow(r, copy.isPresent(), copy.map(ItemCopyRow::rev).orElse(null), copy.map(c -> r.rev() > c.rev()).orElse(false),
                    cards.getOrDefault(r.conn() + "/" + r.item(), List.of()));
            if (MAIN.equals(r.role())) {
                main = row;
            } else {
                items.add(row);
            }
        }
        boolean isLive = rows.stream().map(BoardItemRow::conn).distinct().allMatch(c -> live.vault().token(c).isPresent());
        return new View(boardId, main, items, lastSync.get(boardId), isLive && !rows.isEmpty());
    }

    /** The id an "item" names: the id itself, or the one in a tracker URL / AB#123. */
    static String idOf(String itemOrUrl) {
        if (itemOrUrl == null || itemOrUrl.isBlank() || itemOrUrl.length() > 2000) {
            throw TeamException.invalid("Name the item by its id or its URL");
        }
        String s = itemOrUrl.strip();
        Matcher m = URL_ID.matcher(s);
        if (m.find()) {
            return m.group(1);
        }
        if (s.startsWith("#")) {
            s = s.substring(1);
        }
        if (s.length() > 100 || s.contains("/") || s.contains(" ")) {
            throw TeamException.invalid("No item id in \"" + (s.length() > 60 ? s.substring(0, 60) + "…" : s) + "\"");
        }
        return s;
    }

    // ----------------------------------------------------------------------------------------------------------- add

    @Override
    public View add(Who who, String boardId, String conn, String itemOrUrl, boolean asMain, int maxRefs, String askedIn) {
        board(boardId);
        String id = idOf(itemOrUrl);
        if (who == Who.CLAUDE && !askedByUser(askedIn)) {
            // Claude's link waits for the user: a bundle with the Alfred-side step only (FR-057)
            AzureWritesUseCase w = writes.getIfAvailable();
            if (w == null) {
                throw TeamException.userOnly("Only the user links items to a board");
            }
            Map<String, String> p = new LinkedHashMap<>();
            p.put("board", boardId);
            if (asMain) {
                p.put("asMain", "1");
            }
            w.create(Who.CLAUDE, new NewBundle(boardId, null, conn, id, "Add item " + id + " to the board" + (asMain ? " as its main" : ""),
                    List.of(new WriteStep(StepKind.LINK_ALFRED, p, true, false, null)), null, null));
            throw new TeamException(Code.CONFLICT, "Waiting for the user: the link to item " + id + " is a bundle they approve on the board");
        }
        if (who == Who.CLAUDE && asMain && cache.main(boardId).filter(m -> !(m.conn().equals(conn) && m.item().equals(id))).isPresent()) {
            throw TeamException.userOnly("Only the user changes a board's main item - propose it in the chat");
        }
        Ctx c = live.ctx(conn);
        Item item = live.item(c, id);
        Optional<BoardItemRow> main = cache.main(boardId);
        Optional<BoardItemRow> existing = cache.boardItem(boardId, conn, item.extId());
        if (main.isEmpty() || asMain) {
            if (main.isPresent() && main.get().conn().equals(conn) && main.get().item().equals(item.extId())) {
                return list(boardId);
            }
            rootOn(c, boardId, item, main, cap(maxRefs), who);
        } else if (existing.isEmpty()) {
            cache.putBoardItem(row(boardId, conn, item, REF, "ADDED", null, null, 0, who));
        }
        cache.clearRemoved(boardId, conn, item.extId());
        signals.board(boardId, conn, "items", Map.of());
        return list(boardId);
    }

    private boolean askedByUser(String askedIn) {
        TeamBoardsPort p = boards.getIfAvailable();
        return p != null && askedIn != null && !askedIn.isBlank() && p.askedBy(askedIn.strip());
    }

    static int cap(int maxRefs) {
        if (maxRefs <= 0) {
            return MAX_REFS;
        }
        return Math.min(maxRefs, MAX_REFS_ASKED);
    }

    BoardItemRow row(String boardId, String conn, Item i, String role, String relation, String linkKind, String parent, int depth, Who who) {
        return new BoardItemRow(boardId, conn, i.extId(), role, relation, linkKind, parent, depth, i.type(), i.title(), i.state(),
                live.category(conn, i.type(), i.state()), i.rev(), null, clock.instant(), who == null ? "user" : who.name().toLowerCase());
    }

    /** Makes {@code item} the main: its copy, then its tree as references (the 200 cap asks first). */
    private void rootOn(Ctx c, String boardId, Item item, Optional<BoardItemRow> oldMain, int max, Who who) {
        List<TreeRef> tree = tree(c, item.extId(), max);
        String conn = c.id();
        cache.putCopy(Copies.row(conn, item, comments(c, item.extId()), clock.instant()));
        cache.deleteTreeRefs(boardId);
        Optional<BoardItemRow> before = cache.boardItem(boardId, conn, item.extId());
        cache.putBoardItem(row(boardId, conn, item, before.map(BoardItemRow::role).orElse(REF), "ROOT", null, null, 0, who));
        String oldRole = oldMain.map(m -> cache.cardLinksOfItem(m.conn(), m.item()).stream().anyMatch(l -> boardId.equals(l.boardId())) ? CARD : REF)
                .orElse(REF);
        cache.setMain(boardId, conn, item.extId(), oldRole);
        oldMain.ifPresent(m -> cache.putBoardItem(new BoardItemRow(boardId, m.conn(), m.item(), oldRole, "ADDED",
                null, null, 0, m.type(), m.title(), m.state(), m.stateCategory(), m.rev(), null, m.addedAt(), m.addedBy())));
        placeTree(c, boardId, item.extId(), tree, false, who);
        oldMain.ifPresent(m -> cache.dropCopyIfUnused(m.conn(), m.item()));
    }

    List<TreeRef> tree(Ctx c, String root, int max) {
        if (!(c.connector() instanceof TreeReader r)) {
            return List.of();
        }
        List<TreeRef> refs = live.call(c, () -> r.tree(c.connection(), c.token(), root, max + 1));
        if (refs.size() > max) {
            throw new TeamException(Code.ASK, "Item " + root + " has more than " + max + " related items. Add them all? (up to " + MAX_REFS_ASKED + ")");
        }
        return refs;
    }

    List<Comment> comments(Ctx c, String id) {
        return c.connector() instanceof ItemReader r ? live.call(c, () -> r.comments(c.connection(), c.token(), id)) : List.of();
    }

    /**
     * Writes the tree's rows: a card item keeps its role and takes its place in the tree; the rest are references. Returns
     * the descendants that were not on the board before (for Incoming) when {@code report}.
     */
    private List<Item> placeTree(Ctx c, String boardId, String root, List<TreeRef> tree, boolean report, Who who) {
        String conn = c.id();
        Map<String, TreeRef> byId = new LinkedHashMap<>();
        for (TreeRef t : tree) {
            if (!t.id().equals(root)) {
                byId.putIfAbsent(t.id(), t);
            }
        }
        Map<String, Item> items = new HashMap<>();
        for (Item i : live.items(c, byId.keySet())) {
            items.put(i.extId(), i);
        }
        List<Item> fresh = new ArrayList<>();
        for (TreeRef t : byId.values()) {
            Item i = items.get(t.id());
            if (i == null) {
                continue; // removed or hidden from this token
            }
            Optional<BoardItemRow> had = cache.boardItem(boardId, conn, t.id());
            if (had.isEmpty() && cache.removed(boardId, conn, t.id())) {
                continue; // the user took it off this board
            }
            String role = had.map(BoardItemRow::role).filter(r -> CARD.equals(r)).orElse(REF);
            if (had.isEmpty() && report && TreeRef.DESCENDANT.equals(t.relation())) {
                fresh.add(i);
            }
            BoardItemRow r = row(boardId, conn, i, role, t.relation(), t.linkKind(), t.parent(), t.depth(), who);
            cache.putBoardItem(had.map(h -> new BoardItemRow(r.boardId(), r.conn(), r.item(), r.role(), r.relation(), r.linkKind(), r.parent(),
                    r.depth(), r.type(), r.title(), r.state(), r.stateCategory(), r.rev(), null, h.addedAt(), h.addedBy())).orElse(r));
        }
        return fresh;
    }

    // ----------------------------------------------------------------------------------------------------- main

    @Override
    public MainChange setMain(Who who, String boardId, String conn, String item, int maxRefs) {
        board(boardId);
        if (who == Who.CLAUDE) {
            throw TeamException.userOnly("Only the user changes a board's main item - propose it in the chat");
        }
        Optional<BoardItemRow> old = cache.main(boardId);
        Ctx c = live.ctx(conn);
        Item i = live.item(c, idOf(item));
        if (old.isPresent() && old.get().conn().equals(conn) && old.get().item().equals(i.extId())) {
            return new MainChange(list(boardId), false, null);
        }
        rootOn(c, boardId, i, old, cap(maxRefs), who);
        signals.board(boardId, conn, "items", Map.of("main", i.extId()));
        return new MainChange(list(boardId), true, old.map(BoardItemRow::item).orElse(null));
    }

    @Override
    public View unlink(Who who, String boardId, String conn, String item, String newMain) {
        if (who == Who.CLAUDE) {
            throw TeamException.userOnly("Only the user unlinks an item from a board");
        }
        BoardItemRow row = cache.boardItem(boardId, conn, item).orElseThrow(() -> TeamException.notFound("Item " + item + " is not on this board"));
        if (MAIN.equals(row.role())) {
            boolean alone = cache.boardItems(boardId).stream().allMatch(r -> r.item().equals(item) && r.conn().equals(conn)
                    || REF.equals(r.role()) && !"ADDED".equals(r.relation()));
            if (newMain != null && !newMain.isBlank()) {
                setMain(who, boardId, conn, newMain, MAX_REFS);
                boolean linkedByCard = cache.cardLinksOfBoard(boardId).stream().anyMatch(l -> l.conn().equals(conn) && l.item().equals(item));
                if (!linkedByCard) {
                    cache.deleteBoardItem(boardId, conn, item);
                }
            } else if (alone) {
                cache.deleteTreeRefs(boardId);
                cache.deleteBoardItem(boardId, conn, item);
            } else {
                throw TeamException.invalid("Name the item that becomes the main first (the board keeps one main while it has items)");
            }
        } else {
            boolean linkedByCard = cache.cardLinksOfBoard(boardId).stream().anyMatch(l -> l.conn().equals(conn) && l.item().equals(item));
            if (CARD.equals(row.role()) && linkedByCard) {
                throw TeamException.invalid("A card links item " + item + ": unlink it from the card");
            }
            cache.deleteBoardItem(boardId, conn, item);
            if (Set.of(TreeRef.ANCESTOR, TreeRef.DESCENDANT, TreeRef.LINK).contains(row.relation())) {
                cache.markRemoved(boardId, conn, item, clock.instant());
            }
        }
        cache.dropCopyIfUnused(conn, item);
        signals.board(boardId, conn, "items", Map.of());
        return list(boardId);
    }

    // ------------------------------------------------------------------------------------------------------ sync

    @Override
    public void syncInBackground(String boardId, boolean force) {
        if (!syncing.add(boardId)) {
            return;
        }
        background.submit(() -> {
            try {
                SyncResult r = sync(boardId, force);
                Map<String, Object> extra = new LinkedHashMap<>();
                extra.put("changed", r.changed());
                extra.put("newInTree", r.newInTree());
                extra.put("leftTree", r.leftTree());
                extra.put("skipped", r.skipped());
                signals.board(boardId, null, "sync", extra);
            } catch (TeamException e) {
                signals.board(boardId, null, "sync", Map.of("error", e.code().name(), "message", String.valueOf(e.getMessage())));
            } catch (RuntimeException e) {
                log.warn("Sync of board {} stopped: {}", boardId, e.getClass().getSimpleName());
                signals.board(boardId, null, "sync", Map.of("error", "UNREACHABLE", "message", "The sync stopped"));
            } finally {
                syncing.remove(boardId);
            }
        });
    }

    @Override
    public SyncResult sync(String boardId, boolean force) {
        Instant now = clock.instant();
        Instant last = lastSync.get(boardId);
        if (!force && last != null && last.plus(SYNC_EVERY).isAfter(now)) {
            return new SyncResult(boardId, 0, 0, 0, 0, true);
        }
        List<BoardItemRow> rows = cache.boardItems(boardId);
        if (rows.isEmpty() && cache.cardLinksOfBoard(boardId).isEmpty()) {
            return new SyncResult(boardId, 0, 0, 0, 0, true);
        }
        lastSync.put(boardId, now);
        int checked = 0;
        int changed = 0;
        int fresh = 0;
        int left = 0;
        Map<String, List<BoardItemRow>> byConn = new LinkedHashMap<>();
        for (BoardItemRow r : rows) {
            byConn.computeIfAbsent(r.conn(), k -> new ArrayList<>()).add(r);
        }
        for (CardLinkRow l : cache.cardLinksOfBoard(boardId)) {
            byConn.computeIfAbsent(l.conn(), k -> new ArrayList<>());
        }
        for (Map.Entry<String, List<BoardItemRow>> e : byConn.entrySet()) {
            String conn = e.getKey();
            Ctx c = live.ctx(conn);
            Set<String> full = new LinkedHashSet<>();
            Set<String> refs = new LinkedHashSet<>();
            for (BoardItemRow r : e.getValue()) {
                (MAIN.equals(r.role()) || CARD.equals(r.role()) ? full : refs).add(r.item());
            }
            for (CardLinkRow l : cache.cardLinksOfBoard(boardId)) {
                if (l.conn().equals(conn)) {
                    full.add(l.item());
                    refs.remove(l.item());
                }
            }
            Map<String, Item> now2 = new HashMap<>();
            for (Item i : live.items(c, union(full, refs))) {
                now2.put(i.extId(), i);
            }
            for (String id : full) {
                Item i = now2.get(id);
                checked++;
                if (i == null) {
                    continue;
                }
                if (syncFull(c, boardId, i)) {
                    changed++;
                }
            }
            for (BoardItemRow r : e.getValue()) {
                Item i = now2.get(r.item());
                if (i == null) {
                    if (r.leftTreeAt() == null && !MAIN.equals(r.role())) {
                        cache.markLeftTree(boardId, conn, r.item(), now);
                        left++;
                    }
                    continue;
                }
                cache.putBoardItem(new BoardItemRow(r.boardId(), r.conn(), r.item(), r.role(), r.relation(), r.linkKind(), r.parent(), r.depth(),
                        i.type(), i.title(), i.state(), live.category(conn, i.type(), i.state()), i.rev(), r.leftTreeAt(), r.addedAt(), r.addedBy()));
            }
            Optional<BoardItemRow> main = cache.main(boardId).filter(m -> m.conn().equals(conn));
            if (main.isPresent() && !now2.containsKey(main.get().item())) {
                // deleted in the tracker or hidden from this token: its copy stays; the user picks a new main
                if (main.get().leftTreeAt() == null) {
                    cache.markLeftTree(boardId, conn, main.get().item(), now);
                    signals.board(boardId, conn, "items", Map.of("mainGone", main.get().item()));
                }
                main = Optional.empty();
            }
            if (main.isPresent()) {
                List<TreeRef> tree;
                try {
                    int holds = (int) cache.boardItems(boardId).stream().filter(r -> REF.equals(r.role())).count();
                    tree = tree(c, main.get().item(), Math.min(MAX_REFS_ASKED, Math.max(MAX_REFS, holds + 20)));
                } catch (TeamException ask) {
                    if (ask.code() != Code.ASK) {
                        throw ask;
                    }
                    tree = null; // too big to re-read in a sync: the references stay as they were
                }
                if (tree != null) {
                    Set<String> inTree = new LinkedHashSet<>();
                    tree.forEach(t -> inTree.add(t.id()));
                    for (BoardItemRow r : cache.boardItems(boardId)) {
                        boolean treeRow = TreeRef.ANCESTOR.equals(r.relation()) || TreeRef.DESCENDANT.equals(r.relation())
                                || TreeRef.LINK.equals(r.relation());
                        if (treeRow && !inTree.contains(r.item()) && r.leftTreeAt() == null) {
                            cache.markLeftTree(boardId, conn, r.item(), now);
                            left++;
                        }
                    }
                    List<Item> arrived = placeTree(c, boardId, main.get().item(), tree, true, Who.USER);
                    IncomingUseCase in = incoming.getIfAvailable();
                    TeamUseCase t = team.getIfAvailable();
                    for (Item i : arrived) {
                        fresh++;
                        boolean cardKind = t == null || !"NONE".equals(t.kindOf(conn, i.type()));
                        if (in != null && cardKind && cache.cardLinksOfItem(conn, i.extId()).isEmpty()) {
                            in.arrive(boardId, conn, i, IncomingSource.TREE);
                        }
                    }
                }
            }
        }
        return new SyncResult(boardId, checked, changed, fresh, left, false);
    }

    private static Set<String> union(Set<String> a, Set<String> b) {
        Set<String> out = new LinkedHashSet<>(a);
        out.addAll(b);
        return out;
    }

    /** A full item against its copy: a sync row when anything differs; the copy stays until the user keeps Azure's version. */
    boolean syncFull(Ctx c, String boardId, Item now) {
        String conn = c.id();
        Optional<ItemCopyRow> copy = cache.copy(conn, now.extId());
        List<Comment> comments = comments(c, now.extId());
        if (copy.isEmpty()) {
            cache.putCopy(Copies.row(conn, now, comments, clock.instant()));
            return false;
        }
        Optional<Item> before = Copies.item(copy.get());
        List<FieldDiff> diff = before.map(b -> ItemDiff.diff(b, Copies.comments(copy.get()), now, comments)).orElse(List.of());
        if (diff.isEmpty()) {
            if (now.rev() != copy.get().rev()) {
                cache.putCopy(Copies.row(conn, now, comments, clock.instant())); // only bookkeeping moved
            }
            return false;
        }
        List<SyncRow> last = cache.syncs(conn, now.extId(), 1);
        if (last.isEmpty() || last.get(0).toRev() != now.rev() || last.get(0).kept()) {
            cache.addSync(conn, now.extId(), copy.get().rev(), now.rev(), clock.instant(), diff);
            // a proposal once per new revision - not again on every sync until the copy is kept
            before.ifPresent(b -> closedOrReopened(conn, boardId, b, now));
        }
        return true;
    }

    /** FR-059: a linked item closed or reopened in Azure - the card gets a badge (the diff) and a move proposal. */
    void closedOrReopened(String conn, String boardId, Item before, Item now) {
        boolean wasClosed = Live.closed(live.category(conn, before.type(), before.state()));
        boolean isClosed = Live.closed(live.category(conn, now.type(), now.state()));
        if (wasClosed == isClosed) {
            return;
        }
        TeamBoardsPort p = boards.getIfAvailable();
        if (p == null) {
            return;
        }
        for (CardLinkRow l : cache.cardLinksOfItem(conn, now.extId())) {
            if (boardId != null && l.boardId() != null && !boardId.equals(l.boardId())) {
                continue; // that board's own sync proposes for its cards
            }
            Optional<CardInfo> card = p.card(l.cardId());
            if (card.isEmpty()) {
                continue;
            }
            boolean finished = Set.of("VERIFIED", "DONE", "CLOSED").contains(card.get().status());
            String who = now.changedBy() == null ? "someone" : now.changedBy();
            if (isClosed && !finished) {
                p.propose(l.cardId(), "DONE", null, now.type() + " " + now.extId() + " was set to " + now.state() + " in Azure by " + who);
            } else if (!isClosed && finished) {
                p.proposeReopen(l.cardId(), now.type() + " " + now.extId() + " was reopened (" + now.state() + ") in Azure by " + who);
            }
        }
    }

    @Override
    public View keep(String boardId, String conn, String item) {
        Ctx c = live.ctx(conn);
        Item now = live.item(c, item);
        if (cache.copy(conn, item).isEmpty()) {
            throw TeamException.notFound("Alfred keeps no copy of item " + item);
        }
        cache.putCopy(Copies.row(conn, now, comments(c, item), clock.instant()));
        cache.markSyncsKept(conn, item);
        signals.board(boardId, conn, "items", Map.of());
        return list(boardId);
    }

    @Override
    public List<SyncRow> syncs(String conn, String item, int limit) {
        return cache.syncs(conn, item, Math.max(1, Math.min(limit <= 0 ? 50 : limit, 50)));
    }

    @Override
    public Optional<MainSummary> mainSummary(String boardId) {
        Optional<BoardItemRow> main = cache.main(boardId);
        if (main.isEmpty()) {
            return Optional.empty();
        }
        BoardItemRow m = main.get();
        Optional<Item> copy = cache.copy(m.conn(), m.item()).flatMap(Copies::item);
        Map<String, String> snap = new LinkedHashMap<>();
        put(snap, "title", copy.map(Item::title).orElse(m.title()));
        put(snap, "state", m.state());
        put(snap, "type", m.type());
        copy.ifPresent(i -> {
            put(snap, "assignee", i.assignee());
            put(snap, "sprint", i.sprint());
            put(snap, "area", i.area());
            put(snap, "url", i.url() == null ? null : i.url().toString());
        });
        put(snap, "rev", String.valueOf(m.rev()));
        List<SyncRow> s = cache.syncs(m.conn(), m.item(), 1);
        List<FieldDiff> changes = s.isEmpty() || s.get(0).kept() ? List.of() : s.get(0).diff();
        String provider = cache.connection(m.conn()).flatMap(c -> live.connector(c.kind())).map(k -> k.displayName()).orElse(m.conn());
        return Optional.of(new MainSummary(m.conn(), m.item(), provider, snap, changes));
    }

    private static void put(Map<String, String> m, String k, String v) {
        if (v != null) {
            m.put(k, v);
        }
    }

    @Override
    public void boardDeleted(String boardId) {
        for (String[] held : cache.deleteBoard(boardId)) {
            cache.dropCopyIfUnused(held[0], held[1]);
        }
        lastSync.remove(boardId);
        signals.board(boardId, null, "items", Map.of());
    }

    @Override
    public void cardItem(String boardId, String conn, String item) {
        if (boardId == null) {
            return;
        }
        Optional<BoardItemRow> had = cache.boardItem(boardId, conn, item);
        if (had.isPresent()) {
            if (REF.equals(had.get().role())) {
                cache.setRole(boardId, conn, item, CARD);
            }
            return;
        }
        Optional<Item> copy = cache.copy(conn, item).flatMap(Copies::item);
        cache.putBoardItem(new BoardItemRow(boardId, conn, item, CARD, "ADDED", null, null, 0, copy.map(Item::type).orElse(null),
                copy.map(Item::title).orElse(null), copy.map(Item::state).orElse(null),
                copy.map(i -> live.category(conn, i.type(), i.state())).orElse(null), copy.map(Item::rev).orElse(0), null, clock.instant(), "user"));
    }

    @Override
    public void cardItemGone(String boardId, String conn, String item) {
        if (boardId == null) {
            return;
        }
        boolean stillLinked = cache.cardLinksOfBoard(boardId).stream().anyMatch(l -> l.conn().equals(conn) && l.item().equals(item));
        if (stillLinked) {
            return;
        }
        cache.boardItem(boardId, conn, item).filter(r -> CARD.equals(r.role())).ifPresent(r -> {
            if ("ADDED".equals(r.relation())) {
                cache.deleteBoardItem(boardId, conn, item);
            } else {
                cache.setRole(boardId, conn, item, REF);
            }
        });
    }

}
