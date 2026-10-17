package com.fathy.alfred.backend.teamboards.core.application.service;

import com.fathy.alfred.backend.teamboards.core.application.port.in.LinksUseCase.AttachmentRef;
import com.fathy.alfred.backend.teamboards.core.application.port.in.SeedUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort.StoredConnection;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.FieldMapRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ItemSummary;
import com.fathy.alfred.backend.teamboards.spi.AttachmentsReader;
import com.fathy.alfred.backend.teamboards.spi.Connector;
import com.fathy.alfred.backend.teamboards.spi.SeedContributor;
import com.fathy.alfred.backend.teamboards.spi.model.Item;
import com.fathy.alfred.backend.teamboards.spi.model.Link;
import com.fathy.alfred.backend.teamboards.spi.model.SeedPart;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * The board seed (specs/027 FR-035): each field goes where the field maps say (else its default: description to
 * purpose, repro steps to steps, acceptance criteria to acceptance, the rest to context); a part the connector adds
 * (SeedContributor) fills what the fields left empty; the parent's acceptance and a Feature's or Epic's children follow.
 * Values are kept whole.
 */
@Service
public class SeedBuilder implements SeedUseCase {

    /** Types whose children are the work: their children become the steps. */
    static final Set<String> PARENT_TYPES = Set.of("feature", "epic", "user story", "product backlog item");

    private final Map<String, Connector> connectors;
    private final TeamCachePort cache;

    @Autowired
    public SeedBuilder(List<Connector> connectors, TeamCachePort cache) {
        this.connectors = CachedItems.byKind(connectors);
        this.cache = cache;
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

    /** One part: a single field as it is, several each under its name. */
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
        Optional<StoredConnection> c = cache.connection(conn);
        Optional<Item> found = CachedItems.item(cache, conn, extId);
        Optional<ItemSummary> summary = cache.summary(conn, extId);
        if (c.isEmpty() || found.isEmpty() || summary.isEmpty()) {
            return Optional.empty();
        }
        Item item = found.get();
        Connector k = connectors.get(c.get().kind());
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
        String parentAcceptance = null;
        List<String> children = new ArrayList<>();
        for (Link l : item.links()) {
            if ("Parent".equalsIgnoreCase(l.kind())) {
                parentAcceptance = acceptanceOf(conn, l.toId());
            }
        }
        if (PARENT_TYPES.contains(item.type().toLowerCase(Locale.ROOT))) {
            for (Link l : item.links()) {
                if ("Child".equalsIgnoreCase(l.kind())) {
                    children.add(cache.summary(conn, l.toId()).map(s -> s.extId() + " · " + s.type() + " · " + s.title() + (s.state() == null ? "" : " · " + s.state()))
                            .orElse(l.toId() + " (not in the cache)"));
                }
            }
        }
        List<AttachmentRef> attachments = k instanceof AttachmentsReader r
                ? r.listedIn(item).stream().map(a -> new AttachmentRef(a.name(), a.size(), String.valueOf(a.url()), false)).toList() : List.of();
        String board = cache.linkOfItem(conn, extId).map(l -> l.alfredBoard()).orElse(null);
        return Optional.of(new Seed(summary.get(), k == null ? c.get().kind() : k.displayName(), purpose, steps, acceptance, context, parentAcceptance,
                children, attachments, item.links(), board));
    }

    /** The neutral fields, already on the item itself, are not repeated as context. */
    static boolean skipped(String key) {
        String k = key.toLowerCase(Locale.ROOT);
        return k.equals("system.title") || k.equals("system.state") || k.equals("system.workitemtype") || k.equals("system.assignedto")
                || k.equals("system.areapath") || k.equals("system.iterationpath") || k.equals("system.id") || k.equals("system.rev")
                || k.equals("system.teamproject");
    }

    private String acceptanceOf(String conn, String parentId) {
        Optional<ItemSummary> p = cache.summary(conn, parentId);
        if (p.isEmpty()) {
            return null;
        }
        Map<String, String> maps = maps(conn, p.get().type());
        List<String[]> parts = new ArrayList<>();
        new java.util.TreeMap<>(CachedItems.present(cache.fields(conn, parentId))).forEach((key, v) -> {
            String target = maps.getOrDefault(key, TeamService.defaultTarget(key));
            if ("ACCEPTANCE".equals(target) && !v.isBlank()) {
                parts.add(new String[] {key, v});
            }
        });
        return join(parts);
    }
}
