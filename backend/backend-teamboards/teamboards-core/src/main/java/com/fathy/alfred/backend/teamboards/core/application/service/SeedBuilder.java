package com.fathy.alfred.backend.teamboards.core.application.service;

import com.fathy.alfred.backend.teamboards.core.application.port.in.SeedUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamException;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamBoardsPort;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort.StoredConnection;
import com.fathy.alfred.backend.teamboards.core.application.service.Live.Ctx;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.BoardItemRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.FieldMapRow;
import com.fathy.alfred.backend.teamboards.spi.AttachmentsReader;
import com.fathy.alfred.backend.teamboards.spi.Connector;
import com.fathy.alfred.backend.teamboards.spi.SeedContributor;
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
 * connector adds (SeedContributor) fills what the fields left empty; the parent's acceptance and a parent type's
 * children follow. Values are kept whole.
 */
@Service
public class SeedBuilder implements SeedUseCase {

    /** Types whose children are the work: their children become the steps. */
    static final Set<String> PARENT_TYPES = Set.of("feature", "epic", "user story", "product backlog item");

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
        String board = cache.boardsOfItem(conn, extId).stream().filter(r -> "MAIN".equals(r.role())).map(BoardItemRow::boardId).findFirst().orElse(null);
        String parentAcceptance = null;
        for (Link l : item.links()) {
            if ("Parent".equalsIgnoreCase(l.kind())) {
                parentAcceptance = acceptanceOf(conn, l.toId(), ctx);
            }
        }
        List<String> children = new ArrayList<>();
        if (PARENT_TYPES.contains(item.type().toLowerCase(Locale.ROOT))) {
            Map<String, BoardItemRow> known = new HashMap<>();
            if (board != null) {
                for (BoardItemRow r : cache.boardItems(board)) {
                    known.put(r.item(), r);
                }
            }
            List<String> ids = item.links().stream().filter(l -> "Child".equalsIgnoreCase(l.kind())).map(Link::toId).toList();
            Map<String, Item> liveKids = new HashMap<>();
            List<String> unknown = ids.stream().filter(id -> !known.containsKey(id)).toList();
            if (!unknown.isEmpty() && ctx.isPresent()) {
                live.items(ctx.get(), unknown).forEach(i -> liveKids.put(i.extId(), i));
            }
            for (String id : ids) {
                BoardItemRow r = known.get(id);
                Item i = liveKids.get(id);
                if (r != null) {
                    children.add(id + " · " + r.type() + " · " + r.title() + (r.state() == null ? "" : " · " + r.state()));
                } else if (i != null) {
                    children.add(id + " · " + i.type() + " · " + i.title() + (i.state() == null ? "" : " · " + i.state()));
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
        return Optional.of(new Seed(Copies.lean(item), k == null ? c.kind() : k.displayName(), purpose, steps, acceptance, context, parentAcceptance,
                children, attachments, item.links(), board));
    }

    /** The neutral fields, already on the item itself, are not repeated as context. */
    static boolean skipped(String key) {
        String k = key.toLowerCase(Locale.ROOT);
        return k.equals("system.title") || k.equals("system.state") || k.equals("system.workitemtype") || k.equals("system.assignedto")
                || k.equals("system.areapath") || k.equals("system.iterationpath") || k.equals("system.id") || k.equals("system.rev")
                || k.equals("system.teamproject");
    }

    private String acceptanceOf(String conn, String parentId, Optional<Ctx> ctx) {
        Optional<Item> p = cache.copy(conn, parentId).flatMap(Copies::item);
        if (p.isEmpty() && ctx.isPresent()) {
            try {
                p = Optional.of(live.item(ctx.get(), parentId));
            } catch (TeamException e) {
                return null;
            }
        }
        if (p.isEmpty()) {
            return null;
        }
        Map<String, String> maps = maps(conn, p.get().type());
        List<String[]> parts = new ArrayList<>();
        new java.util.TreeMap<>(p.get().fields()).forEach((key, v) -> {
            String target = maps.getOrDefault(key, TeamService.defaultTarget(key));
            if ("ACCEPTANCE".equals(target) && !v.isBlank()) {
                parts.add(new String[] {key, v});
            }
        });
        return join(parts);
    }
}
