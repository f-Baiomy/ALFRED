package com.fathy.alfred.backend.teamboards.core.application.service;

import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamException;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort.MeOverride;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort.SquadIn;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort.StoredConnection;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamChangeSignalPort;
import com.fathy.alfred.backend.teamboards.core.application.service.Live.Ctx;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.BoardRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ConnectionRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ConnectorInfo;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.FieldMapRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.Lists;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.MappingKind;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.MappingRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.Me;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.PersonRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.SprintRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.SquadRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.StateRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.TokenStatus;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.TypeKindRow;
import com.fathy.alfred.backend.teamboards.spi.BoardsReader;
import com.fathy.alfred.backend.teamboards.spi.Connector;
import com.fathy.alfred.backend.teamboards.spi.IdentityReader;
import com.fathy.alfred.backend.teamboards.spi.ProviderException;
import com.fathy.alfred.backend.teamboards.spi.ProviderWords;
import com.fathy.alfred.backend.teamboards.spi.SprintsReader;
import com.fathy.alfred.backend.teamboards.spi.SquadsReader;
import com.fathy.alfred.backend.teamboards.spi.StateCatalog;
import com.fathy.alfred.backend.teamboards.spi.model.Capability;
import com.fathy.alfred.backend.teamboards.spi.model.ItemTypeInfo;
import com.fathy.alfred.backend.teamboards.spi.model.Person;
import com.fathy.alfred.backend.teamboards.spi.model.Scope;
import com.fathy.alfred.backend.teamboards.spi.model.Squad;
import com.fathy.alfred.backend.teamboards.spi.model.Token;
import com.fathy.alfred.backend.teamboards.spi.model.TypeStates;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Connections, the token, the filter lists, me, and where items open their boards (specs/028 FR-001..018, FR-085..087).
 * The lists are the only Team data kept besides a board's saved copies; work items are read live elsewhere.
 */
@Service
public class TeamService implements TeamUseCase {

    private static final Logger log = LoggerFactory.getLogger(TeamService.class);

    /** Connectors Alfred knows of but does not ship yet: listed so Settings can say "not installed". */
    static final Map<String, String> KNOWN = Map.of("azure", "Azure DevOps", "jira", "Jira", "clickup", "ClickUp");

    /** FR-056: the default card kind of a type; Feature and Epic stay in Related items. */
    static final Map<String, String> DEFAULT_KINDS = Map.of("bug", "BUG", "task", "TASK", "user story", "TASK", "product backlog item", "TASK",
            "issue", "QUESTION", "impediment", "QUESTION", "feature", "NONE", "epic", "NONE");
    static final Set<String> KINDS = Set.of("BUG", "TASK", "QUESTION", "NOTE", "NONE");

    private final Live live;
    private final TeamCachePort cache;
    private final TeamChangeSignalPort signals;
    private final Clock clock;
    private final Set<String> reading = ConcurrentHashMap.newKeySet();
    private final ExecutorService background = Executors.newFixedThreadPool(2, r -> {
        Thread t = new Thread(r, "team-lists");
        t.setDaemon(true);
        return t;
    });

    /** The hook's waiting ids are read once a token is there; optional so tests build this service alone. */
    private org.springframework.beans.factory.ObjectProvider<com.fathy.alfred.backend.teamboards.core.application.port.in.HookUseCase> hook;

    @Autowired
    public TeamService(Live live, TeamCachePort cache, TeamChangeSignalPort signals,
                       org.springframework.beans.factory.ObjectProvider<com.fathy.alfred.backend.teamboards.core.application.port.in.HookUseCase> hook) {
        this(live, cache, signals, Clock.systemUTC());
        this.hook = hook;
    }

    TeamService(Live live, TeamCachePort cache, TeamChangeSignalPort signals, Clock clock) {
        this.live = live;
        this.cache = cache;
        this.signals = signals;
        this.clock = clock;
    }

    // ------------------------------------------------------------------------------------------------------ connectors

    @Override
    public List<Capability> capabilities(String kind) {
        return live.connector(kind).map(c -> List.copyOf(Live.capabilitiesOf(c))).orElse(List.of());
    }

    @Override
    public List<ConnectorInfo> connectors() {
        List<ConnectorInfo> out = new ArrayList<>();
        for (Connector c : live.connectors().values()) {
            out.add(new ConnectorInfo(c.kind(), c.displayName(), true, Live.capabilitiesOf(c), words(c.words())));
        }
        KNOWN.forEach((kind, name) -> {
            if (!live.connectors().containsKey(kind)) {
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
        return new ConnectionRow(c.id(), c.kind(), c.name(), c.baseUrl(), c.scope(), c.listsAt(), c.createdAt(),
                live.connector(c.kind()).map(Live::capabilitiesOf).orElse(Set.of()));
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
    public ConnectionRow createConnection(NewConnection in) {
        if (in == null || in.kind() == null || !live.connectors().containsKey(in.kind())) {
            String kind = in == null ? "" : String.valueOf(in.kind());
            throw TeamException.invalid(KNOWN.containsKey(kind) ? KNOWN.get(kind) + " is not installed in this Alfred" : "Unknown connector");
        }
        String url = validUrl(in.baseUrl());
        if (url == null) {
            throw TeamException.invalid("The address must be https (http only on localhost)");
        }
        String problem = scopeProblem(in.scope());
        if (problem != null) {
            throw TeamException.invalid(problem);
        }
        String name = in.name() == null || in.name().isBlank() ? URI.create(url).getHost() : in.name().strip();
        if (name.length() > 120) {
            throw TeamException.invalid("A connection's name is at most 120 characters");
        }
        StoredConnection c = new StoredConnection(UUID.randomUUID().toString().substring(0, 8), in.kind(), name, url,
                in.scope() == null ? new Scope(List.of(), List.of()) : in.scope(), null, clock.instant());
        cache.putConnection(c);
        signals.changed(c.id(), "connections");
        return row(c);
    }

    @Override
    public ConnectionRow updateConnection(String id, String name, Scope scope) {
        StoredConnection c = live.stored(id);
        String problem = scopeProblem(scope);
        if (problem != null) {
            throw TeamException.invalid(problem);
        }
        if (name != null && name.strip().length() > 120) {
            throw TeamException.invalid("A connection's name is at most 120 characters");
        }
        String newName = name == null || name.isBlank() ? c.name() : name.strip();
        Scope newScope = scope == null ? c.scope() : scope;
        cache.rescope(c.id(), newName, newScope);
        signals.changed(id, "connections");
        if (!newScope.equals(c.scope())) {
            listsInBackground(id); // a new scope reads its lists again
        }
        return row(new StoredConnection(c.id(), c.kind(), newName, c.baseUrl(), newScope, c.listsAt(), c.createdAt()));
    }

    @Override
    public boolean deleteConnection(String id) {
        boolean gone = cache.deleteConnection(id);
        live.vault().forget(id);
        if (gone) {
            signals.changed(id, "connections");
        }
        return gone;
    }

    // ---------------------------------------------------------------------------------------------------------- token

    static PersonRow person(Person p) {
        return p == null ? null : new PersonRow(p.extId(), p.name() == null || p.name().isBlank() ? p.extId() : p.name(), p.email());
    }

    @Override
    public TokenStatus putToken(String conn, Token token) {
        if (token == null || token.blank() || token.value().length() > 1000) {
            throw TeamException.invalid("Paste a personal access token");
        }
        Ctx c = live.ctx(conn, new Token(token.value().strip()));
        PersonRow owner = null;
        if (c.connector() instanceof IdentityReader r) {
            owner = person(live.call(c, () -> r.whoAmI(c.connection(), c.token())));
        } else {
            live.call(c, () -> c.connector().types(c.connection(), c.token())); // any read proves the token works
        }
        Optional<PersonRow> before = live.vault().put(conn, c.token(), owner);
        if (owner != null) {
            cache.upsertPeople(conn, List.of(owner));
            PersonRow o = owner;
            // "This is me" holds until the token changes hands (FR-087)
            cache.meOverride(conn).filter(m -> before.isPresent() || (m.tokenOwner() != null && !m.tokenOwner().equals(o.extId())))
                    .ifPresent(m -> cache.clearMeOverride(conn));
        }
        signals.changed(conn, "token");
        listsInBackground(conn);
        var h = hook == null ? null : hook.getIfAvailable();
        if (h != null) {
            h.drain(conn);
        }
        return tokenStatus(conn);
    }

    @Override
    public TokenStatus tokenStatus(String conn) {
        live.stored(conn);
        return live.vault().entry(conn).map(e -> new TokenStatus(true, e.owner(), e.expiresAt())).orElse(new TokenStatus(false, null, null));
    }

    @Override
    public boolean forgetToken(String conn) {
        boolean was = live.vault().forget(conn);
        signals.changed(conn, "token");
        return was;
    }

    // ------------------------------------------------------------------------------------------------------- the lists

    @Override
    public Lists lists(String conn, int maxAgeMinutes) {
        StoredConnection c = live.stored(conn);
        boolean stale = c.listsAt() == null || c.listsAt().isBefore(clock.instant().minus(Duration.ofMinutes(Math.max(0, maxAgeMinutes))));
        if (stale && live.vault().token(conn).isPresent()) {
            listsInBackground(conn);
        }
        return cached(conn, c.listsAt());
    }

    private Lists cached(String conn, Instant at) {
        List<StateRow> states = cache.states(conn);
        List<String> types = states.stream().map(StateRow::type).distinct().sorted().toList();
        return new Lists(types, states, cache.areas(conn), cache.squads(conn), cache.sprints(conn), cache.people(conn), cache.boards(conn), at);
    }

    private void listsInBackground(String conn) {
        if (live.vault().token(conn).isEmpty() || !reading.add(conn)) {
            return;
        }
        background.submit(() -> {
            try {
                readLists(conn);
            } catch (TeamException e) {
                log.info("Team lists of {} not read: {}", conn, e.code());
            } catch (RuntimeException e) {
                log.warn("Team lists of {} not read: {}", conn, e.getClass().getSimpleName());
            } finally {
                reading.remove(conn);
            }
        });
    }

    @Override
    public Lists refreshLists(String conn) {
        return readLists(conn);
    }

    /** Each list is read on its own: one the tracker refuses (a scope the token lacks) leaves the others current. */
    Lists readLists(String conn) {
        Ctx c = live.ctx(conn);
        Connector k = c.connector();
        List<String> failed = new ArrayList<>();
        if (k instanceof StateCatalog sc) {
            attempt(c, failed, "states", () -> {
                List<StateRow> rows = new ArrayList<>();
                for (TypeStates ts : sc.states(c.connection(), c.token())) {
                    for (TypeStates.State s : ts.states()) {
                        rows.add(new StateRow(ts.project(), ts.type(), s.name(), s.category()));
                    }
                }
                cache.replaceStates(conn, rows);
            });
            attempt(c, failed, "areas", () -> cache.replaceAreas(conn, sc.areas(c.connection(), c.token())));
        } else {
            attempt(c, failed, "types", () -> {
                List<StateRow> rows = new ArrayList<>();
                for (ItemTypeInfo t : k.types(c.connection(), c.token())) {
                    rows.add(new StateRow("", t.name(), "", ""));
                }
                cache.replaceStates(conn, rows);
            });
        }
        attempt(c, failed, "people", () -> cache.upsertPeople(conn, k.people(c.connection(), c.token()).stream().map(TeamService::person).toList()));
        if (k instanceof SquadsReader r) {
            attempt(c, failed, "teams", () -> {
                List<Squad> squads = r.squads(c.connection(), c.token());
                cache.replaceSquads(conn, squads.stream().map(s -> new SquadIn(s.extId(), s.name(), s.project(), s.memberIds())).toList());
                Set<String> members = new LinkedHashSet<>();
                squads.forEach(s -> members.addAll(s.memberIds()));
                List<String> unknown = cache.unknownPeople(conn, members);
                if (!unknown.isEmpty() && k instanceof IdentityReader ir) {
                    // FR-085: members show as people, never as raw ids
                    for (int i = 0; i < unknown.size(); i += 100) {
                        List<String> chunk = unknown.subList(i, Math.min(unknown.size(), i + 100));
                        cache.upsertPeople(conn, ir.peopleById(c.connection(), c.token(), chunk).stream().map(TeamService::person).toList());
                    }
                }
            });
        }
        if (k instanceof SprintsReader r) {
            attempt(c, failed, "iterations", () -> cache.replaceSprints(conn, r.sprints(c.connection(), c.token()).stream()
                    .map(s -> new SprintRow(s.extId(), s.name(), s.team(), s.starts(), s.ends())).toList()));
        }
        if (k instanceof BoardsReader r) {
            attempt(c, failed, "boards", () -> cache.replaceBoards(conn, r.boards(c.connection(), c.token()).stream()
                    .map(b -> new BoardRow(b.extId(), b.name(), b.project(), b.team(), b.columns())).toList()));
        }
        Instant at = clock.instant();
        cache.markLists(conn, at);
        signals.board(null, conn, "lists", failed.isEmpty() ? Map.of() : Map.of("failed", String.join(", ", failed)));
        return cached(conn, at);
    }

    interface Step {
        void run() throws ProviderException;
    }

    private void attempt(Ctx c, List<String> failed, String what, Step step) {
        try {
            step.run();
        } catch (ProviderException e) {
            if (e.kind() == ProviderException.Kind.TOKEN_REJECTED) {
                live.vault().rejected(c.id(), c.token());
                throw TeamException.of(e);
            }
            failed.add(what + " (" + e.getMessage() + ")");
        }
    }

    @Override
    public List<BoardRow> boards(String conn) {
        live.stored(conn);
        return cache.boards(conn);
    }

    @Override
    public List<SprintRow> sprints(String conn) {
        live.stored(conn);
        return cache.sprints(conn);
    }

    @Override
    public List<SquadRow> squads(String conn) {
        live.stored(conn);
        return cache.squads(conn);
    }

    @Override
    public List<PersonRow> people(String conn) {
        return cache.people(conn);
    }

    @Override
    public SquadRow mapSquad(String conn, String extId, String alfredProject, String alfredTeam) {
        if ((alfredProject != null && alfredProject.length() > 200) || (alfredTeam != null && alfredTeam.length() > 200)) {
            throw TeamException.invalid("Names are at most 200 characters");
        }
        if (!cache.mapSquad(conn, extId, blankToNull(alfredProject), blankToNull(alfredTeam))) {
            throw TeamException.notFound("No such team");
        }
        signals.changed(conn, "lists");
        return cache.squads(conn).stream().filter(s -> s.extId().equals(extId)).findFirst().orElseThrow(() -> TeamException.notFound("No such team"));
    }

    // ------------------------------------------------------------------------------------------------------------ me

    @Override
    public Optional<Me> me(String conn) {
        Optional<MeOverride> o = cache.meOverride(conn);
        Optional<PersonRow> owner = live.vault().owner(conn);
        if (o.isPresent()) {
            // a token of someone else since "This is me" was set: the override no longer holds
            if (owner.isPresent() && o.get().tokenOwner() != null && !o.get().tokenOwner().equals(owner.get().extId())) {
                cache.clearMeOverride(conn);
            } else {
                PersonRow p = cache.person(conn, o.get().person()).orElse(new PersonRow(o.get().person(), o.get().person(), null));
                return Optional.of(new Me(p, "OVERRIDE"));
            }
        }
        return owner.map(p -> new Me(p, "TOKEN_OWNER"));
    }

    @Override
    public Me putMe(String conn, String person) {
        live.stored(conn);
        PersonRow p = cache.person(conn, person == null ? "" : person.strip()).orElseThrow(() -> TeamException.notFound("No such person " + person));
        cache.putMeOverride(new MeOverride(conn, p.extId(), live.vault().owner(conn).map(PersonRow::extId).orElse(null), clock.instant()));
        signals.changed(conn, "me");
        return new Me(p, "OVERRIDE");
    }

    @Override
    public void clearMe(String conn) {
        cache.clearMeOverride(conn);
        signals.changed(conn, "me");
    }

    // ------------------------------------------------------------------------------------------------ mappings, fields

    @Override
    public List<MappingRow> mappings(String conn) {
        return cache.mappings(conn);
    }

    @Override
    public MappingRow putMapping(String conn, MappingKind kind, String extValue, String alfredProject, String alfredBoard) {
        live.stored(conn);
        if (kind == null || extValue == null || extValue.isBlank() || extValue.length() > 300 || alfredProject == null || alfredProject.isBlank()
                || alfredProject.length() > 200 || (alfredBoard != null && alfredBoard.length() > 200)) {
            throw TeamException.invalid("A mapping names the kind, the provider value and an Alfred project");
        }
        MappingRow row = cache.putMapping(conn, kind, extValue.strip(), alfredProject.strip(), blankToNull(alfredBoard));
        signals.changed(conn, "mappings");
        return row;
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
    public FieldMapRow putFieldMap(FieldMapRow row) {
        if (row == null) {
            throw TeamException.invalid("No field map");
        }
        live.stored(row.conn());
        if (row.target() == null || row.field() == null || row.field().isBlank() || row.field().length() > 200 || row.itemType() == null
                || row.itemType().isBlank() || row.itemType().length() > 200) {
            throw TeamException.invalid("A field map names the item type (or *), the field and its target");
        }
        cache.putFieldMap(row);
        signals.changed(row.conn(), "mappings");
        return row;
    }

    @Override
    public boolean deleteFieldMap(String conn, String itemType, String field) {
        boolean gone = cache.deleteFieldMap(conn, itemType, field);
        if (gone) {
            signals.changed(conn, "mappings");
        }
        return gone;
    }

    static String defaultKind(String type) {
        return type == null ? "NOTE" : DEFAULT_KINDS.getOrDefault(type.strip().toLowerCase(Locale.ROOT), "NOTE");
    }

    @Override
    public List<TypeKindRow> typeKinds(String conn) {
        live.stored(conn);
        Map<String, TypeKindRow> out = new LinkedHashMap<>();
        for (StateRow s : cache.states(conn)) {
            out.putIfAbsent(s.type().toLowerCase(Locale.ROOT), new TypeKindRow(conn, s.type(), defaultKind(s.type())));
        }
        for (TypeKindRow r : cache.typeKinds(conn)) {
            out.put(r.type().toLowerCase(Locale.ROOT), r);
        }
        return out.values().stream().sorted((a, b) -> a.type().compareToIgnoreCase(b.type())).toList();
    }

    @Override
    public TypeKindRow putTypeKind(String conn, String type, String kind) {
        live.stored(conn);
        String k = kind == null ? "" : kind.strip().toUpperCase(Locale.ROOT);
        if (type == null || type.isBlank() || type.length() > 200 || !KINDS.contains(k)) {
            throw TeamException.invalid("A type maps to BUG, TASK, QUESTION, NOTE or NONE");
        }
        TypeKindRow row = new TypeKindRow(conn, type.strip(), k);
        cache.putTypeKind(row);
        signals.changed(conn, "mappings");
        return row;
    }

    @Override
    public String kindOf(String conn, String type) {
        for (TypeKindRow r : cache.typeKinds(conn)) {
            if (r.type().equalsIgnoreCase(type)) {
                return r.kind();
            }
        }
        return defaultKind(type);
    }

    @Override
    public boolean upgradeNotice() {
        return cache.upgradeNotice();
    }

    @Override
    public void dismissUpgradeNotice() {
        cache.dismissUpgradeNotice();
        signals.changed(null, "connections");
    }

    static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s.strip();
    }

    /** Where a field goes in a seed when nobody mapped it (the neutral names every connector fills). */
    static String defaultTarget(String key) {
        String k = key.toLowerCase(Locale.ROOT);
        if (k.endsWith("description")) return "PURPOSE";
        if (k.contains("reprosteps") || k.endsWith("steps")) return "STEPS";
        if (k.contains("acceptancecriteria")) return "ACCEPTANCE";
        return null;
    }
}
