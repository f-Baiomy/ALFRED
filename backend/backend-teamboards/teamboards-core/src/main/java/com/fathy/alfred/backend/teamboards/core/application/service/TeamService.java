package com.fathy.alfred.backend.teamboards.core.application.service;

import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort.StoredConnection;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamChangeSignalPort;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.BoardRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ChangeRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ConnectionRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ConnectorInfo;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.FieldMapRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ItemDetail;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ItemField;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ItemQuery;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ItemSummary;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ItemsPage;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.MappingKind;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.MappingRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.PersonRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.RefreshOutcome;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.RefreshResult;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.RevisionRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.SprintRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.SquadRow;
import com.fathy.alfred.backend.teamboards.spi.AttachmentsReader;
import com.fathy.alfred.backend.teamboards.spi.BoardsReader;
import com.fathy.alfred.backend.teamboards.spi.Connector;
import com.fathy.alfred.backend.teamboards.spi.ProviderException;
import com.fathy.alfred.backend.teamboards.spi.ProviderWords;
import com.fathy.alfred.backend.teamboards.spi.RevisionsReader;
import com.fathy.alfred.backend.teamboards.spi.SeedContributor;
import com.fathy.alfred.backend.teamboards.spi.SprintsReader;
import com.fathy.alfred.backend.teamboards.spi.SquadsReader;
import com.fathy.alfred.backend.teamboards.spi.model.Capability;
import com.fathy.alfred.backend.teamboards.spi.model.Connection;
import com.fathy.alfred.backend.teamboards.spi.model.Item;
import com.fathy.alfred.backend.teamboards.spi.model.Revision;
import com.fathy.alfred.backend.teamboards.spi.model.Scope;
import com.fathy.alfred.backend.teamboards.spi.model.Token;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The Team tab's service (specs/027 US7, research R8-R11). Capabilities come from the interfaces a connector implements,
 * so none can be claimed. A refresh asks only for what changed since the last one and writes page by page; every new
 * revision becomes a line of the shared changes feed. The token is used for the call and dropped.
 */
@Service
public class TeamService implements TeamUseCase {

    /** Connectors Alfred knows of but does not ship yet: listed so Settings can say "not installed". */
    static final Map<String, String> KNOWN = Map.of("azure", "Azure DevOps", "jira", "Jira", "clickup", "ClickUp");

    private final Map<String, Connector> connectors = new LinkedHashMap<>();
    private final TeamCachePort cache;
    private final TeamChangeSignalPort signals;
    private final Clock clock;
    /** One refresh per connection at a time: a second click joins nothing, it is refused as busy. */
    private final Set<String> refreshing = ConcurrentHashMap.newKeySet();

    @Value("${alfred.teamboards.max-items:100000}")
    int maxItems = 100_000;
    @Value("${alfred.teamboards.max-revisions:200000}")
    int maxRevisions = 200_000;
    @Value("${alfred.teamboards.changes-max-rows:50000}")
    int maxChangeRows = 50_000;
    @Value("${alfred.teamboards.changes-max-age-days:90}")
    int changesMaxAgeDays = 90;

    @Autowired
    public TeamService(List<Connector> connectors, TeamCachePort cache, TeamChangeSignalPort signals) {
        this(connectors, cache, signals, Clock.systemUTC());
    }

    TeamService(List<Connector> connectors, TeamCachePort cache, TeamChangeSignalPort signals, Clock clock) {
        for (Connector c : connectors == null ? List.<Connector>of() : connectors) {
            this.connectors.put(c.kind(), c);
        }
        this.cache = cache;
        this.signals = signals;
        this.clock = clock;
    }

    // ------------------------------------------------------------------------------------------------------ connectors

    static Set<Capability> capabilitiesOf(Connector c) {
        Set<Capability> out = EnumSet.of(Capability.CUSTOM_TYPES);
        if (c instanceof BoardsReader) out.add(Capability.BOARDS);
        if (c instanceof SprintsReader) out.add(Capability.SPRINTS);
        if (c instanceof SquadsReader) out.add(Capability.SQUADS);
        if (c instanceof RevisionsReader) out.add(Capability.REVISIONS);
        if (c instanceof AttachmentsReader) out.add(Capability.ATTACHMENTS);
        if (c instanceof SeedContributor) out.add(Capability.SEED);
        return out;
    }

    @Override
    public List<Capability> capabilities(String kind) {
        Connector c = connectors.get(kind);
        return c == null ? List.of() : List.copyOf(capabilitiesOf(c));
    }

    @Override
    public List<ConnectorInfo> connectors() {
        List<ConnectorInfo> out = new ArrayList<>();
        for (Connector c : connectors.values()) {
            out.add(new ConnectorInfo(c.kind(), c.displayName(), true, capabilitiesOf(c), words(c.words())));
        }
        KNOWN.forEach((kind, name) -> {
            if (!connectors.containsKey(kind)) {
                out.add(new ConnectorInfo(kind, name, false, Set.of(), words(ProviderWords.NEUTRAL)));
            }
        });
        out.sort((a, b) -> Boolean.compare(b.installed(), a.installed()) != 0 ? Boolean.compare(b.installed(), a.installed())
                : a.kind().compareTo(b.kind()));
        return out;
    }

    private static Map<String, String> words(ProviderWords w) {
        return Map.of("sprint", w.sprint(), "squad", w.squad(), "area", w.area(), "item", w.item());
    }

    // ----------------------------------------------------------------------------------------------------- connections

    @Override
    public List<ConnectionRow> connections() {
        return cache.connections().stream().map(this::row).toList();
    }

    private ConnectionRow row(StoredConnection c) {
        Connector k = connectors.get(c.kind());
        return new ConnectionRow(c.id(), c.kind(), c.name(), c.baseUrl(), c.scope(), c.fetchedAt(), c.fetchedBy(), c.seenAt(), c.createdAt(),
                k == null ? Set.of() : capabilitiesOf(k), cache.changesAfter(c.id(), c.seenAt()));
    }

    /** https anywhere; http only on this machine (a local mock of a provider). */
    static String validUrl(String url) {
        if (url == null || url.isBlank() || url.length() > 500) {
            return null;
        }
        try {
            URI u = URI.create(url.strip());
            String host = u.getHost();
            if (host == null) {
                return null;
            }
            boolean local = host.equals("localhost") || host.equals("127.0.0.1") || host.equals("[::1]");
            if (!"https".equalsIgnoreCase(u.getScheme()) && !("http".equalsIgnoreCase(u.getScheme()) && local)) {
                return null;
            }
            String s = u.toString();
            return s.endsWith("/") ? s.substring(0, s.length() - 1) : s;
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    static String scopeProblem(Scope s) {
        if (s == null) {
            return null;
        }
        if (s.projects().size() > Scope.MAX_PROJECTS || s.teams().size() > Scope.MAX_TEAMS) {
            return "A connection reads at most " + Scope.MAX_PROJECTS + " projects and " + Scope.MAX_TEAMS + " teams";
        }
        if (s.projects().stream().anyMatch(p -> p == null || p.isBlank() || p.length() > 200)
                || s.teams().stream().anyMatch(t -> t == null || t.isBlank() || t.length() > 200)) {
            return "Project and team names are 1 to 200 characters";
        }
        return null;
    }

    @Override
    public Result<ConnectionRow> createConnection(NewConnection in) {
        if (in == null || in.kind() == null || !connectors.containsKey(in.kind())) {
            return Result.no(Outcome.INVALID, KNOWN.containsKey(in == null ? "" : String.valueOf(in.kind()))
                    ? KNOWN.get(in.kind()) + " is not installed in this Alfred" : "Unknown connector");
        }
        String url = validUrl(in.baseUrl());
        if (url == null) {
            return Result.no(Outcome.INVALID, "The address must be https (http only on localhost)");
        }
        String problem = scopeProblem(in.scope());
        if (problem != null) {
            return Result.no(Outcome.INVALID, problem);
        }
        String name = in.name() == null || in.name().isBlank() ? URI.create(url).getHost() : in.name().strip();
        if (name.length() > 120) {
            return Result.no(Outcome.INVALID, "A connection's name is at most 120 characters");
        }
        StoredConnection c = new StoredConnection(UUID.randomUUID().toString().substring(0, 8), in.kind(), name, url,
                in.scope() == null ? new Scope(List.of(), List.of()) : in.scope(), null, null, null, clock.instant());
        cache.putConnection(c);
        signals.changed(c.id(), "connections");
        return Result.ok(row(c));
    }

    @Override
    public Result<ConnectionRow> updateConnection(String id, String name, Scope scope) {
        Optional<StoredConnection> found = cache.connection(id);
        if (found.isEmpty()) {
            return Result.no(Outcome.NOT_FOUND, "No such connection");
        }
        String problem = scopeProblem(scope);
        if (problem != null) {
            return Result.no(Outcome.INVALID, problem);
        }
        if (name != null && name.strip().length() > 120) {
            return Result.no(Outcome.INVALID, "A connection's name is at most 120 characters");
        }
        StoredConnection c = found.get();
        boolean widened = scope != null && !scope.equals(c.scope());
        StoredConnection next = new StoredConnection(c.id(), c.kind(), name == null || name.isBlank() ? c.name() : name.strip(), c.baseUrl(),
                scope == null ? c.scope() : scope, widened ? null : c.fetchedAt(), c.fetchedBy(), c.seenAt(), c.createdAt());
        cache.putConnection(next); // a new scope fetches everything again on the next refresh
        signals.changed(id, "connections");
        return Result.ok(row(next));
    }

    @Override
    public boolean deleteConnection(String id) {
        boolean gone = cache.deleteConnection(id);
        if (gone) {
            signals.changed(id, "connections");
        }
        return gone;
    }

    // --------------------------------------------------------------------------------------------------------- refresh

    private static Connection conn(StoredConnection c) {
        return new Connection(c.id(), c.kind(), c.name(), URI.create(c.baseUrl()), c.scope());
    }

    @Override
    public RefreshResult refresh(String id, Token token, String who) {
        Optional<StoredConnection> found = cache.connection(id);
        if (found.isEmpty()) {
            return RefreshResult.of(RefreshOutcome.NOT_FOUND, "No such connection");
        }
        Connector k = connectors.get(found.get().kind());
        if (k == null) {
            return RefreshResult.of(RefreshOutcome.NOT_FOUND, "The " + found.get().kind() + " connector is not installed");
        }
        if (token == null || token.blank()) {
            return RefreshResult.of(RefreshOutcome.TOKEN_MISSING, "Add your personal access token for " + found.get().name() + " first");
        }
        if (!refreshing.add(id)) {
            return new RefreshResult(RefreshOutcome.PROVIDER_BUSY, 0, null, 5, "A refresh of this connection is already running");
        }
        try {
            StoredConnection c = found.get();
            Connection connection = conn(c);
            Instant started = clock.instant();
            int[] changed = {0};
            k.changedItems(connection, token, c.fetchedAt(), page -> changed[0] += store(c.id(), page, started));
            if (k instanceof SquadsReader r) {
                cache.replaceSquads(c.id(), r.squads(connection, token).stream()
                        .map(s -> new SquadRow(c.id(), s.extId(), s.name(), s.project(), null, null, s.memberIds())).toList());
            }
            cache.replacePeople(c.id(), k.people(connection, token).stream().map(p -> new PersonRow(p.extId(), p.name(), p.email())).toList());
            if (k instanceof BoardsReader r) {
                cache.replaceBoards(c.id(), r.boards(connection, token).stream()
                        .map(b -> new BoardRow(b.extId(), b.name(), b.project(), b.team(), b.columns())).toList());
            }
            if (k instanceof SprintsReader r) {
                cache.replaceSprints(c.id(), r.sprints(connection, token).stream()
                        .map(s -> new SprintRow(s.extId(), s.name(), s.team(), s.starts(), s.ends())).toList());
            }
            String by = who == null || who.isBlank() ? "someone" : who.strip().substring(0, Math.min(80, who.strip().length()));
            cache.markFetched(c.id(), started, by);
            cache.evict(maxItems, maxRevisions, maxChangeRows, clock.instant().minus(Duration.ofDays(changesMaxAgeDays)));
            signals.changed(c.id(), "items");
            if (changed[0] > 0) {
                signals.changed(c.id(), "changes");
            }
            return new RefreshResult(RefreshOutcome.OK, changed[0], started, null, null);
        } catch (ProviderException e) {
            return switch (e.kind()) {
                case TOKEN_REJECTED -> RefreshResult.of(RefreshOutcome.TOKEN_REJECTED, "The provider refused the token - it may have expired");
                case BUSY -> new RefreshResult(RefreshOutcome.PROVIDER_BUSY, 0, null, e.retryAfterSeconds(), "The provider asks to wait");
                case NOT_FOUND -> RefreshResult.of(RefreshOutcome.NOT_FOUND, e.getMessage());
                case UNREACHABLE -> RefreshResult.of(RefreshOutcome.UNREACHABLE, e.getMessage());
                case BAD_RESPONSE -> RefreshResult.of(RefreshOutcome.BAD_RESPONSE, e.getMessage());
            };
        } finally {
            refreshing.remove(id);
        }
    }

    /** One page into the cache, and a feed line for every item that is new or has a newer revision. Items changed. */
    int store(String conn, List<Item> page, Instant fetchedAt) {
        if (page == null || page.isEmpty()) {
            return 0;
        }
        Map<String, Integer> before = cache.revs(conn, page.stream().map(Item::extId).toList());
        List<String[]> lines = new ArrayList<>();
        for (Item i : page) {
            Integer old = before.get(i.extId());
            if (old != null && old >= i.rev()) {
                continue;
            }
            lines.add(new String[]{i.extId(), summaryOf(old == null ? null : cache.summary(conn, i.extId()).orElse(null), i)});
        }
        cache.upsertItems(conn, page, fetchedAt);
        Map<String, Item> byId = new LinkedHashMap<>();
        page.forEach(i -> byId.put(i.extId(), i));
        for (String[] l : lines) {
            Item i = byId.get(l[0]);
            cache.addChange(conn, i.extId(), i.rev(), i.changedBy(), i.squad(), i.changedAt() == null ? fetchedAt : i.changedAt(), l[1]);
        }
        return lines.size();
    }

    /** "created", or what changed among the neutral fields: "State Active → Resolved; Assignee A → B". */
    static String summaryOf(ItemSummary old, Item now) {
        if (old == null) {
            return "created " + now.type() + (now.state() == null ? "" : " (" + now.state() + ")");
        }
        List<String> parts = new ArrayList<>();
        diff(parts, "Title", old.title(), now.title());
        diff(parts, "State", old.state(), now.state());
        diff(parts, "Assignee", old.assignee(), now.assignee());
        diff(parts, "Sprint", old.sprint(), now.sprint());
        diff(parts, "Squad", old.squad(), now.squad());
        diff(parts, "Area", old.area(), now.area());
        return parts.isEmpty() ? "edited" : String.join("; ", parts);
    }

    private static void diff(List<String> parts, String name, String a, String b) {
        if (!Objects.equals(a, b)) {
            parts.add(name + " " + (a == null || a.isBlank() ? "-" : cut(a)) + " → " + (b == null || b.isBlank() ? "-" : cut(b)));
        }
    }

    private static String cut(String s) {
        return s.length() > 60 ? s.substring(0, 59) + "…" : s;
    }

    // ----------------------------------------------------------------------------------------------------------- reads

    @Override
    public ItemsPage items(ItemQuery q) {
        int limit = Math.max(1, Math.min(q.limit() <= 0 ? 50 : q.limit(), MAX_LIMIT));
        String text = q.q() == null ? null : q.q().strip();
        if (text != null && text.length() > 200) {
            text = text.substring(0, 200);
        }
        return cache.items(new ItemQuery(q.conn(), text, q.type(), q.squad(), q.state(), q.assignee(), q.sprint(), Math.max(0, q.offset()), limit));
    }

    @Override
    public Optional<ItemDetail> item(String conn, String extId) {
        Optional<ItemSummary> s = cache.summary(conn, extId);
        if (s.isEmpty()) {
            return Optional.empty();
        }
        Map<String, String> maps = new LinkedHashMap<>();
        for (FieldMapRow m : cache.fieldMaps(conn)) {
            if (m.itemType().equals("*") || m.itemType().equalsIgnoreCase(s.get().type())) {
                maps.put(m.field(), m.target().name());
            }
        }
        List<ItemField> fields = new ArrayList<>();
        cache.fields(conn, extId).forEach((k, v) -> fields.add(new ItemField(k, v, maps.getOrDefault(k, defaultTarget(k)))));
        String board = cache.linkOfItem(conn, extId).map(l -> l.alfredBoard()).orElse(null);
        return Optional.of(new ItemDetail(s.get(), fields, cache.links(conn, extId), board, null));
    }

    /** Where a field goes in a seed when nobody mapped it (the neutral names every connector fills). */
    static String defaultTarget(String key) {
        String k = key.toLowerCase(Locale.ROOT);
        if (k.endsWith("description")) return "PURPOSE";
        if (k.contains("reprosteps") || k.endsWith("steps")) return "STEPS";
        if (k.contains("acceptancecriteria")) return "ACCEPTANCE";
        return null;
    }

    @Override
    public Result<List<RevisionRow>> revisions(String conn, String extId, Token token, boolean fetch) {
        Optional<StoredConnection> c = cache.connection(conn);
        if (c.isEmpty() || cache.summary(conn, extId).isEmpty()) {
            return Result.no(Outcome.NOT_FOUND, "No such item in the cache");
        }
        Connector k = connectors.get(c.get().kind());
        if (!(k instanceof RevisionsReader r)) {
            return Result.no(Outcome.NOT_SUPPORTED, "This connector does not read history");
        }
        List<RevisionRow> cached = cache.revisions(conn, extId);
        if ((cached.isEmpty() || fetch) && token != null && !token.blank()) {
            try {
                List<Revision> got = r.revisions(conn(c.get()), token, extId);
                cache.putRevisions(conn, extId, got.stream().map(v -> new RevisionRow(v.rev(), v.by(), v.at(), v.changes())).toList());
                cached = cache.revisions(conn, extId);
            } catch (ProviderException e) {
                // the cached history (maybe none) is still the answer; the token problem shows on the next refresh
            }
        }
        return Result.ok(cached);
    }

    private <T> Result<List<T>> gated(String conn, Capability cap, java.util.function.Supplier<List<T>> read) {
        Optional<StoredConnection> c = cache.connection(conn);
        if (c.isEmpty()) {
            return Result.no(Outcome.NOT_FOUND, "No such connection");
        }
        Connector k = connectors.get(c.get().kind());
        if (k == null || !capabilitiesOf(k).contains(cap)) {
            return Result.no(Outcome.NOT_SUPPORTED, "This connector does not read " + cap.name().toLowerCase(Locale.ROOT));
        }
        return Result.ok(read.get());
    }

    @Override
    public Result<List<BoardRow>> boards(String conn) {
        return gated(conn, Capability.BOARDS, () -> cache.boards(conn));
    }

    @Override
    public Result<List<SprintRow>> sprints(String conn) {
        return gated(conn, Capability.SPRINTS, () -> cache.sprints(conn));
    }

    @Override
    public Result<List<SquadRow>> squads(String conn) {
        return gated(conn, Capability.SQUADS, () -> cache.squads(conn));
    }

    @Override
    public List<PersonRow> people(String conn) {
        return cache.people(conn);
    }

    @Override
    public Result<SquadRow> mapSquad(String conn, String extId, String alfredProject, String alfredTeam) {
        if ((alfredProject != null && alfredProject.length() > 200) || (alfredTeam != null && alfredTeam.length() > 200)) {
            return Result.no(Outcome.INVALID, "Names are at most 200 characters");
        }
        if (!cache.mapSquad(conn, extId, blankToNull(alfredProject), blankToNull(alfredTeam))) {
            return Result.no(Outcome.NOT_FOUND, "No such squad");
        }
        signals.changed(conn, "squads");
        return cache.squads(conn).stream().filter(s -> s.extId().equals(extId)).findFirst().map(Result::ok)
                .orElseGet(() -> Result.no(Outcome.NOT_FOUND, "No such squad"));
    }

    @Override
    public List<ChangeRow> changes(String conn, String squad, String person, Long after, int limit) {
        return cache.changes(conn, blankToNull(squad), blankToNull(person), after, Math.max(1, Math.min(limit <= 0 ? 100 : limit, MAX_LIMIT)));
    }

    @Override
    public boolean markSeen(String conn) {
        if (cache.connection(conn).isEmpty()) {
            return false;
        }
        cache.markSeen(conn, clock.instant());
        signals.changed(conn, "changes");
        return true;
    }

    // ------------------------------------------------------------------------------------------------ mappings, fields

    @Override
    public List<MappingRow> mappings(String conn) {
        return cache.mappings(conn);
    }

    @Override
    public Result<MappingRow> putMapping(String conn, MappingKind kind, String extValue, String alfredProject, String alfredBoard) {
        if (cache.connection(conn).isEmpty()) {
            return Result.no(Outcome.NOT_FOUND, "No such connection");
        }
        if (kind == null || extValue == null || extValue.isBlank() || extValue.length() > 300 || alfredProject == null || alfredProject.isBlank()
                || alfredProject.length() > 200 || (alfredBoard != null && alfredBoard.length() > 200)) {
            return Result.no(Outcome.INVALID, "A mapping names the kind, the provider value and an Alfred project");
        }
        MappingRow row = cache.putMapping(conn, kind, extValue.strip(), alfredProject.strip(), blankToNull(alfredBoard));
        signals.changed(conn, "mappings");
        return Result.ok(row);
    }

    @Override
    public boolean deleteMapping(String conn, long id) {
        boolean gone = cache.deleteMapping(conn, id);
        if (gone) {
            signals.changed(conn, "mappings");
        }
        return gone;
    }

    @Override
    public List<FieldMapRow> fieldMaps(String conn) {
        return cache.fieldMaps(conn);
    }

    @Override
    public Result<FieldMapRow> putFieldMap(FieldMapRow row) {
        if (row == null || cache.connection(row.conn()).isEmpty()) {
            return Result.no(Outcome.NOT_FOUND, "No such connection");
        }
        if (row.target() == null || row.field() == null || row.field().isBlank() || row.field().length() > 200 || row.itemType() == null
                || row.itemType().isBlank() || row.itemType().length() > 200) {
            return Result.no(Outcome.INVALID, "A field map names the item type (or *), the field and its target");
        }
        cache.putFieldMap(row);
        signals.changed(row.conn(), "mappings");
        return Result.ok(row);
    }

    @Override
    public boolean deleteFieldMap(String conn, String itemType, String field) {
        boolean gone = cache.deleteFieldMap(conn, itemType, field);
        if (gone) {
            signals.changed(conn, "mappings");
        }
        return gone;
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s.strip();
    }

    /** For the connector modules' own wiring checks and the bridge. */
    public Optional<Connector> connector(String kind) {
        return Optional.ofNullable(connectors.get(kind));
    }

    Optional<StoredConnection> stored(String id) {
        return cache.connection(id);
    }
}
