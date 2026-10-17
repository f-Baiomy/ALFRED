package com.fathy.alfred.backend.teamboards.core.application.service;

import com.fathy.alfred.backend.teamboards.core.application.port.in.SeedUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.SeedUseCase.SeedChild;
import com.fathy.alfred.backend.teamboards.core.application.port.in.SeedUseCase.SeedComment;
import com.fathy.alfred.backend.teamboards.core.application.port.in.SeedUseCase.SeedParent;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamException;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamBoardsPort;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort.StoredConnection;
import com.fathy.alfred.backend.teamboards.core.application.service.Live.Ctx;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.BoardItemRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.FieldMapRow;
import com.fathy.alfred.backend.teamboards.spi.AttachmentsReader;
import com.fathy.alfred.backend.teamboards.spi.Connector;
import com.fathy.alfred.backend.teamboards.spi.ItemReader;
import com.fathy.alfred.backend.teamboards.spi.SeedContributor;
import com.fathy.alfred.backend.teamboards.spi.model.Comment;
import com.fathy.alfred.backend.teamboards.spi.model.Item;
import com.fathy.alfred.backend.teamboards.spi.model.Link;
import com.fathy.alfred.backend.teamboards.spi.model.SeedPart;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * The board seed (specs/027 FR-035, 028 FR-039): each field goes where the field maps say (else its default:
 * description to purpose, repro steps to steps, acceptance criteria to acceptance, the rest to context); a part the
 * connector adds (SeedContributor) fills what the fields left empty. Every child follows in full (its own parts, comments,
 * done or not, its children as lines) and the parent chain up to the top (specs/030). Values are kept whole.
 */
@Service
public class SeedBuilder implements SeedUseCase {

    /** How far up the parent chain the seed reads (an Epic sits 2-3 levels up; a loop never runs away). */
    static final int MAX_PARENTS = 6;
    /** The title of a parent the token cannot read; the chain stops there. */
    static final String NOT_READABLE = "not readable with the current token (deleted, or in a project it cannot see)";

    private final Live live;
    private final TeamCachePort cache;
    private final ObjectProvider<TeamBoardsPort> boards;

    public SeedBuilder(Live live, TeamCachePort cache, ObjectProvider<TeamBoardsPort> boards) {
        this.live = live;
        this.cache = cache;
        this.boards = boards;
    }

    /** Field maps for the item's type, a type's own map before the "*" one. */
    Map<String, String> maps(String conn, String type) {
        Map<String, String> out = new LinkedHashMap<>();
        for (FieldMapRow m : cache.fieldMaps(conn)) {
            if (m.itemType().equals("*")) out.putIfAbsent(m.field(), m.target().name());
        }
        for (FieldMapRow m : cache.fieldMaps(conn)) {
            if (m.itemType().equalsIgnoreCase(type)) out.put(m.field(), m.target().name());
        }
        return out;
    }

    private static String join(List<String[]> parts) {
        if (parts.isEmpty()) {
            return null;
        }
        if (parts.size() == 1) {
            return parts.get(0)[1];
        }
        StringBuilder b = new StringBuilder();
        for (String[] p : parts) {
            if (!b.isEmpty()) b.append("\n\n");
            b.append("**").append(p[0]).append("**\n").append(p[1]);
        }
        return b.toString();
    }

    @Override
    public Optional<Seed> seed(String conn, String extId) {
        StoredConnection c = live.stored(conn);
        Optional<Item> found = cache.copy(conn, extId).flatMap(Copies::item);
        Optional<Ctx> ctx = live.ctxIfLive(conn);
        if (found.isEmpty()) {
            if (ctx.isEmpty()) {
                throw new TeamException(TeamException.Code.TOKEN_MISSING, "Item " + extId + " has no saved copy: enter your token to read it live");
            }
            found = Optional.of(live.item(ctx.get(), extId));
        }
        Item item = found.get();
        Connector k = live.connector(c.kind()).orElse(null);
        Mapped m = mapped(conn, item, k);
        String board = cache.boardsOfItem(conn, extId).stream().filter(r -> "MAIN".equals(r.role())).map(BoardItemRow::boardId).findFirst().orElse(null);
        List<SeedParent> parents = parents(conn, item, ctx, k);
        String parentAcceptance = parents.isEmpty() ? null : parents.get(0).acceptance();
        List<String> children = new ArrayList<>();
        List<SeedChild> childItems = new ArrayList<>();
        List<String> ids = item.links().stream().filter(l -> "Child".equalsIgnoreCase(l.kind())).map(Link::toId).toList();
        if (!ids.isEmpty()) {
            Map<String, BoardItemRow> known = new HashMap<>();
            if (board != null) {
                for (BoardItemRow r : cache.boardItems(board)) {
                    known.put(r.item(), r);
                }
            }
            Map<String, Item> kids = read(conn, ids, ctx);
            Map<String, Item> grand = read(conn, kids.values().stream().flatMap(i -> i.links().stream())
                    .filter(l -> "Child".equalsIgnoreCase(l.kind())).map(Link::toId).distinct().toList(), ctx);
            for (String id : ids) {
                BoardItemRow r = known.get(id);
                Item i = kids.get(id);
                if (i != null) {
                    children.add(line(i));
                    childItems.add(child(conn, i, ctx, k, grand));
                } else if (r != null) {
                    children.add(id + " · " + r.type() + " · " + r.title() + (r.state() == null ? "" : " · " + r.state()));
                } else {
                    children.add(id);
                }
            }
        }
        TeamBoardsPort port = boards.getIfAvailable();
        Set<String> held = board == null || port == null ? Set.of() : port.files(board);
        List<AttachmentRef> attachments = k instanceof AttachmentsReader r
                ? r.listedIn(item).stream().map(a -> new AttachmentRef(a.name(), a.size(), String.valueOf(a.url()), held.contains(a.name()))).toList()
                : List.of();
        return Optional.of(new Seed(Copies.lean(item), k == null ? c.kind() : k.displayName(), m.purpose(), m.steps(), m.acceptance(), m.context(),
                parentAcceptance, children, attachments, item.links(), board, childItems, parents, comments(conn, extId, ctx)));
    }

    /** An item's fields sorted into the four parts by the field maps, then what the connector adds for empty parts. */
    record Mapped(String purpose, String steps, String acceptance, String context) {
    }

    Mapped mapped(String conn, Item item, Connector k) {
        Map<String, String> maps = maps(conn, item.type());
        Map<String, List<String[]>> parts = new LinkedHashMap<>();
        for (String t : List.of("PURPOSE", "STEPS", "ACCEPTANCE", "CONTEXT")) {
            parts.put(t, new ArrayList<>());
        }
        for (Map.Entry<String, String> f : new java.util.TreeMap<>(item.fields()).entrySet()) {
            if (f.getValue().isBlank() || skipped(f.getKey())) {
                continue;
            }
            String target = maps.get(f.getKey());
            if (target == null) {
                target = TeamService.defaultTarget(f.getKey());
            }
            parts.get(target == null ? "CONTEXT" : target).add(new String[] {f.getKey(), f.getValue()});
        }
        String purpose = join(parts.get("PURPOSE"));
        String steps = join(parts.get("STEPS"));
        String acceptance = join(parts.get("ACCEPTANCE"));
        String context = join(parts.get("CONTEXT"));
        if (k instanceof SeedContributor sc) {
            SeedPart p = sc.seed(item);
            if (p != null) {
                purpose = purpose == null ? p.purpose() : purpose;
                steps = steps == null ? p.steps() : steps;
                acceptance = acceptance == null ? p.acceptance() : acceptance;
                context = context == null ? p.context() : context;
            }
        }
        return new Mapped(purpose, steps, acceptance, context);
    }

    private static String line(Item i) {
        return i.extId() + " · " + i.type() + " · " + i.title() + (i.state() == null ? "" : " · " + i.state());
    }

    /** Items by id: the saved copy when there is one, the rest in one live read; an item neither has is left out. */
    private Map<String, Item> read(String conn, List<String> ids, Optional<Ctx> ctx) {
        Map<String, Item> out = new LinkedHashMap<>();
        List<String> missing = new ArrayList<>();
        for (String id : ids) {
            Optional<Item> copy = cache.copy(conn, id).flatMap(Copies::item);
            if (copy.isPresent()) {
                out.put(id, copy.get());
            } else {
                missing.add(id);
            }
        }
        if (!missing.isEmpty() && ctx.isPresent()) {
            try {
                live.items(ctx.get(), missing).forEach(i -> out.put(i.extId(), i));
            } catch (TeamException e) {
                // unreadable with this token: those ids stay bare lines
            }
        }
        return out;
    }

    private SeedChild child(String conn, Item i, Optional<Ctx> ctx, Connector k, Map<String, Item> grand) {
        Mapped m = mapped(conn, i, k);
        String category = live.category(conn, i.type(), i.state());
        boolean done = Live.closed(category) || "Resolved".equalsIgnoreCase(category);
        List<String> kids = i.links().stream().filter(l -> "Child".equalsIgnoreCase(l.kind())).map(Link::toId)
                .map(id -> grand.containsKey(id) ? line(grand.get(id)) : id).toList();
        return new SeedChild(i.extId(), i.type(), i.title(), i.state(), category, done, i.assignee(), i.url() == null ? null : i.url().toString(),
                m.purpose(), m.steps(), m.acceptance(), m.context(), comments(conn, i.extId(), ctx), kids);
    }

    /** The parent chain, nearest first, up to the top - at most {@link #MAX_PARENTS}, never the same item twice. */
    private List<SeedParent> parents(String conn, Item item, Optional<Ctx> ctx, Connector k) {
        List<SeedParent> out = new ArrayList<>();
        Set<String> seen = new java.util.HashSet<>(List.of(item.extId()));
        Item at = item;
        while (out.size() < MAX_PARENTS) {
            String up = at.links().stream().filter(l -> "Parent".equalsIgnoreCase(l.kind())).map(Link::toId).findFirst().orElse(null);
            if (up == null || !seen.add(up)) {
                break;
            }
            Item p = read(conn, List.of(up), ctx).get(up);
            if (p == null) {
                // deleted, or in a project the token cannot see: named, never left blank (specs/030 edge cases)
                out.add(new SeedParent(up, null, NOT_READABLE, null, null, null, null));
                break;
            }
            Mapped m = mapped(conn, p, k);
            out.add(new SeedParent(p.extId(), p.type(), p.title(), p.state(), p.url() == null ? null : p.url().toString(), m.purpose(), m.acceptance()));
            at = p;
        }
        return out;
    }

    /** An item's comments, whole: from its saved copy, else live; none when neither can say. */
    private List<SeedComment> comments(String conn, String id, Optional<Ctx> ctx) {
        List<Comment> found = cache.copy(conn, id).map(Copies::comments).orElse(null);
        if (found == null && ctx.isPresent() && ctx.get().connector() instanceof ItemReader r) {
            try {
                found = live.call(ctx.get(), () -> r.comments(ctx.get().connection(), ctx.get().token(), id));
            } catch (TeamException e) {
                found = null;
            }
        }
        return found == null ? List.of() : found.stream()
                .map(cm -> new SeedComment(cm.by(), cm.at() == null ? null : cm.at().toString(), cm.text())).toList();
    }

    /** The neutral fields, already on the item itself, are not repeated as context. */
    static boolean skipped(String key) {
        String k = key.toLowerCase(Locale.ROOT);
        return k.equals("system.title") || k.equals("system.state") || k.equals("system.workitemtype") || k.equals("system.assignedto")
                || k.equals("system.areapath") || k.equals("system.iterationpath") || k.equals("system.id") || k.equals("system.rev")
                || k.equals("system.teamproject");
    }
}
