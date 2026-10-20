package com.fathy.alfred.backend.teamboards.azure;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.teamboards.spi.AttachmentWriter;
import com.fathy.alfred.backend.teamboards.spi.AttachmentsReader;
import com.fathy.alfred.backend.teamboards.spi.BoardsReader;
import com.fathy.alfred.backend.teamboards.spi.Connector;
import com.fathy.alfred.backend.teamboards.spi.FieldCatalog;
import com.fathy.alfred.backend.teamboards.spi.HookReader;
import com.fathy.alfred.backend.teamboards.spi.IdentityReader;
import com.fathy.alfred.backend.teamboards.spi.ItemReader;
import com.fathy.alfred.backend.teamboards.spi.ItemSearcher;
import com.fathy.alfred.backend.teamboards.spi.ItemWriter;
import com.fathy.alfred.backend.teamboards.spi.ProviderException;
import com.fathy.alfred.backend.teamboards.spi.ProviderException.Kind;
import com.fathy.alfred.backend.teamboards.spi.ProviderWords;
import com.fathy.alfred.backend.teamboards.spi.QueryRunner;
import com.fathy.alfred.backend.teamboards.spi.RevisionsReader;
import com.fathy.alfred.backend.teamboards.spi.SeedContributor;
import com.fathy.alfred.backend.teamboards.spi.SprintsReader;
import com.fathy.alfred.backend.teamboards.spi.SquadsReader;
import com.fathy.alfred.backend.teamboards.spi.StateCatalog;
import com.fathy.alfred.backend.teamboards.spi.TreeReader;
import com.fathy.alfred.backend.teamboards.spi.model.Attachment;
import com.fathy.alfred.backend.teamboards.spi.model.Comment;
import com.fathy.alfred.backend.teamboards.spi.model.Connection;
import com.fathy.alfred.backend.teamboards.spi.model.FieldInfo;
import com.fathy.alfred.backend.teamboards.spi.model.Item;
import com.fathy.alfred.backend.teamboards.spi.model.ItemUpdate;
import com.fathy.alfred.backend.teamboards.spi.model.ItemPage;
import com.fathy.alfred.backend.teamboards.spi.model.ItemQuery;
import com.fathy.alfred.backend.teamboards.spi.model.ItemTypeInfo;
import com.fathy.alfred.backend.teamboards.spi.model.Link;
import com.fathy.alfred.backend.teamboards.spi.model.NewItem;
import com.fathy.alfred.backend.teamboards.spi.model.Person;
import com.fathy.alfred.backend.teamboards.spi.model.ProviderBoard;
import com.fathy.alfred.backend.teamboards.spi.model.Revision;
import com.fathy.alfred.backend.teamboards.spi.model.SeedPart;
import com.fathy.alfred.backend.teamboards.spi.model.Sprint;
import com.fathy.alfred.backend.teamboards.spi.model.Squad;
import com.fathy.alfred.backend.teamboards.spi.model.Token;
import com.fathy.alfred.backend.teamboards.spi.model.TreeRef;
import com.fathy.alfred.backend.teamboards.spi.model.TypeStates;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Deque;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.ConcurrentHashMap;

import static com.fathy.alfred.backend.teamboards.azure.AzureClient.API;
import static com.fathy.alfred.backend.teamboards.azure.AzureMapper.encode;

/**
 * Azure DevOps (specs/027, 028 contracts/connector-spi.md). The connection's base URL is the organisation
 * ({@code https://dev.azure.com/<org>}); its scope names the projects and teams (none: every project the token sees).
 * Everything is read live; the only memory is a few minutes of each connection's closed states and team areas, so a
 * search costs one WIQL (or Search) call and one batch. Writes happen only when core asks for an approved step.
 */
@Component
public class AzureDevOpsConnector implements Connector, BoardsReader, SprintsReader, SquadsReader, RevisionsReader, AttachmentsReader,
        SeedContributor, ItemSearcher, QueryRunner, ItemReader, TreeReader, IdentityReader, StateCatalog, ItemWriter, AttachmentWriter, HookReader,
        FieldCatalog {

    static final int BATCH = 200;
    static final long MEMORY_MS = 10 * 60_000L;
    static final Set<String> CLOSED_CATEGORIES = Set.of("Completed", "Removed");

    private final AzureClient client;
    private final ObjectMapper json = new ObjectMapper();
    /** Per connection: the closed state names and when they were read. */
    private final Map<String, Remembered<Set<String>>> closed = new ConcurrentHashMap<>();
    private final Map<String, Remembered<Map<String, Boolean>>> teamAreas = new ConcurrentHashMap<>();
    /** Connections whose organisation has no Search extension (404): they use WIQL. */
    private final Set<String> noSearch = ConcurrentHashMap.newKeySet();

    record Remembered<T>(T value, long at) {
        boolean fresh() {
            return System.currentTimeMillis() - at < MEMORY_MS;
        }
    }

    public AzureDevOpsConnector() {
        this(new AzureClient());
    }

    AzureDevOpsConnector(AzureClient client) {
        this.client = client;
    }

    @Override
    public String kind() {
        return "azure";
    }

    @Override
    public String displayName() {
        return "Azure DevOps";
    }

    @Override
    public ProviderWords words() {
        return new ProviderWords("Iteration", "Team", "Area Path", "Work item");
    }

    static URI org(Connection c) {
        String s = c.baseUrl().toString();
        return URI.create(s.endsWith("/") ? s.substring(0, s.length() - 1) : s);
    }

    private static URI at(Connection c, String path) {
        return URI.create(org(c) + path + (path.contains("?") ? "&" : "?") + API);
    }

    /** Another Azure service of the same organisation: dev.azure.com/x -> {service}.dev.azure.com/x; elsewhere the org itself. */
    static URI service(Connection c, String service) {
        URI o = org(c);
        String host = o.getHost() == null ? "" : o.getHost().toLowerCase(Locale.ROOT);
        if (host.equals("dev.azure.com")) {
            return URI.create("https://" + service + ".dev.azure.com" + o.getPath());
        }
        if (host.endsWith(".visualstudio.com")) {
            String name = host.substring(0, host.indexOf('.'));
            return URI.create("https://" + name + "." + service + ".visualstudio.com");
        }
        return o;
    }

    /** The scope's projects, or every project the token can read. */
    List<String> projects(Connection c, Token t) throws ProviderException {
        if (!c.scope().projects().isEmpty()) {
            return c.scope().projects();
        }
        List<String> out = new ArrayList<>();
        for (JsonNode p : paged(c, t, "/_apis/projects", 500)) {
            out.add(p.path("name").asText());
        }
        return out;
    }

    // ---------------------------------------------------------------------------------------------------- search

    @Override
    public ItemPage search(Connection c, Token t, ItemQuery q) throws ProviderException {
        if (AzureWiql.searchable(q) && !noSearch.contains(c.id())) {
            try {
                return fullText(c, t, q);
            } catch (ProviderException e) {
                if (e.kind() != Kind.NOT_FOUND) {
                    throw e;
                }
                noSearch.add(c.id()); // no Search extension here: WIQL from now on
            }
        }
        return wiqlPage(c, t, q);
    }

    /** The Search API (full text over title, description, comments...), then one batch for the page's items. */
    ItemPage fullText(Connection c, Token t, ItemQuery q) throws ProviderException {
        Map<String, Object> filters = new LinkedHashMap<>();
        List<String> projects = c.scope().projects();
        if (!projects.isEmpty()) {
            filters.put("System.TeamProject", projects);
        }
        if (!q.types().isEmpty()) {
            filters.put("System.WorkItemType", q.types());
        }
        if (!q.states().isEmpty()) {
            filters.put("System.State", q.states());
        }
        if (!q.assigned().isEmpty()) {
            filters.put("System.AssignedTo", q.assigned());
        }
        if (!q.areas().isEmpty()) {
            filters.put("System.AreaPath", q.areas());
        }
        Object order = List.of(Map.of("field", q.sort() == ItemQuery.Sort.ID ? "system.id" : "system.changeddate", "sortOrder", "DESC"));
        URI url = URI.create(service(c, "almsearch") + "/_apis/search/workitemsearchresults?" + API);
        if (!(q.openOnly() && q.states().isEmpty())) {
            JsonNode found = client.post(url, t, searchBody(q.text(), filters, order, q.page() * q.pageSize(), q.pageSize()));
            List<Item> items = items(c, t, searchIds(found));
            return new ItemPage(items, found.path("count").asInt(items.size()), true);
        }
        // Open only is applied after (the Search API filters by state names, and closed ones differ per process): the
        // raw results are read in order and the open ones counted until this page is full, so pages never repeat or skip
        Set<String> shut = closedStates(c, t);
        int want = (q.page() + 1) * q.pageSize();
        List<Item> open = new ArrayList<>();
        int skip = 0;
        int count = 0;
        int closed = 0;
        boolean end = false;
        while (open.size() < want && skip < RAW_LIMIT) {
            JsonNode found = client.post(url, t, searchBody(q.text(), filters, order, skip, RAW_BATCH));
            count = found.path("count").asInt(count);
            List<String> ids = searchIds(found);
            if (ids.isEmpty()) {
                end = true;
                break;
            }
            for (Item i : items(c, t, ids)) {
                if (i.state() == null || !shut.contains(i.state())) {
                    open.add(i);
                } else {
                    closed++;
                }
            }
            skip += ids.size();
            if (ids.size() < RAW_BATCH || skip >= count) {
                end = true;
                break;
            }
        }
        int from = Math.min(open.size(), q.page() * q.pageSize());
        List<Item> page = open.subList(from, Math.min(open.size(), from + q.pageSize()));
        int total = end ? open.size() : Math.max(open.size(), count - closed);
        return new ItemPage(List.copyOf(page), total, true);
    }

    private static final int RAW_BATCH = 200;
    private static final int RAW_LIMIT = 2000;

    private static Map<String, Object> searchBody(String text, Map<String, Object> filters, Object order, int skip, int top) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("searchText", text);
        body.put("$skip", skip);
        body.put("$top", top);
        body.put("filters", filters);
        body.put("includeFacets", false);
        body.put("$orderBy", order);
        return body;
    }

    private static List<String> searchIds(JsonNode found) {
        List<String> ids = new ArrayList<>();
        for (JsonNode r : found.path("results")) {
            String id = r.path("fields").path("system.id").asText(null);
            if (id != null) {
                ids.add(id);
            }
        }
        return ids;
    }

    /** WIQL: every id that matches (ordered), then the page's items in one batch. */
    ItemPage wiqlPage(Connection c, Token t, ItemQuery q) throws ProviderException {
        List<String> projects = c.scope().projects();
        String team = q.teams().size() == 1 ? q.teams().get(0) : null;
        // "current" is each picked team's own sprint; with no team picked, the plain macro (the scope's team, or the default)
        List<String> current = q.teams().isEmpty() ? List.of("@CurrentIteration")
                : q.teams().stream().map(x -> "@CurrentIteration(" + AzureWiql.quote(bracket(x)) + ")").toList();
        String where = AzureWiql.where(q, projects, q.openOnly() && q.states().isEmpty() ? closedStates(c, t) : Set.of(), areasOf(c, t, q.teams()),
                current);
        String wiql = "SELECT [System.Id] FROM WorkItems WHERE " + where + AzureWiql.order(q.sort());
        List<String> ids = wiqlIds(c, t, wiql, team);
        int from = Math.min(ids.size(), q.page() * q.pageSize());
        List<String> page = ids.subList(from, Math.min(ids.size(), from + q.pageSize()));
        return new ItemPage(items(c, t, page), ids.size(), false);
    }

    /** "Project\Team" -> "[Project]\Team" (the macro's own form). */
    static String bracket(String team) {
        int cut = team.indexOf('\\');
        return cut < 0 ? team : "[" + team.substring(0, cut) + "]\\" + team.substring(cut + 1);
    }

    /** One WIQL call's ids; times to the second ({@code timePrecision}). {@code team}: "Project\Team" for @CurrentIteration. */
    List<String> wiqlIds(Connection c, Token t, String wiql, String team) throws ProviderException {
        String path = "/_apis/wit/wiql?timePrecision=true";
        if (team != null && team.contains("\\")) {
            String[] pt = team.split("\\\\", 2);
            path = "/" + encode(pt[0]) + "/" + encode(pt[1]) + path;
        } else if (c.scope().projects().size() == 1) {
            path = "/" + encode(c.scope().projects().get(0)) + path;
        }
        JsonNode found;
        try {
            found = client.post(at(c, path), t, Map.of("query", wiql));
        } catch (ProviderException e) {
            if (e.getMessage() != null && e.getMessage().contains("VS402337")) {
                throw new ProviderException(Kind.BAD_RESPONSE, "More than 20,000 work items match - add a filter (type, state, area, iteration…)");
            }
            throw e;
        }
        List<String> ids = new ArrayList<>();
        for (JsonNode w : found.path("workItems")) {
            ids.add(w.path("id").asText());
        }
        return ids;
    }

    /** The state names whose category is Completed or Removed, for Open only (remembered 10 minutes). */
    Set<String> closedStates(Connection c, Token t) throws ProviderException {
        Remembered<Set<String>> r = closed.get(c.id());
        if (r != null && r.fresh()) {
            return r.value();
        }
        Set<String> out = new TreeSet<>();
        for (TypeStates ts : states(c, t)) {
            for (TypeStates.State s : ts.states()) {
                if (CLOSED_CATEGORIES.contains(s.category())) {
                    out.add(s.name());
                }
            }
        }
        closed.put(c.id(), new Remembered<>(out, System.currentTimeMillis()));
        return out;
    }

    /** Each team's own area paths ({@code teamfieldvalues}), with whether their children count. */
    Map<String, Boolean> areasOf(Connection c, Token t, List<String> teams) throws ProviderException {
        Map<String, Boolean> out = new LinkedHashMap<>();
        for (String team : teams) {
            String key = c.id() + "|" + team;
            Remembered<Map<String, Boolean>> r = teamAreas.get(key);
            if (r == null || !r.fresh()) {
                String[] pt = team.split("\\\\", 2);
                if (pt.length < 2) {
                    throw new ProviderException(Kind.BAD_RESPONSE, "A team is named \"Project\\Team\" (got " + team + ")");
                }
                Map<String, Boolean> areas = new LinkedHashMap<>();
                JsonNode v = client.get(at(c, "/" + encode(pt[0]) + "/" + encode(pt[1]) + "/_apis/work/teamsettings/teamfieldvalues"), t);
                for (JsonNode a : v.path("values")) {
                    areas.put(a.path("value").asText(), a.path("includeChildren").asBoolean(false));
                }
                r = new Remembered<>(areas, System.currentTimeMillis());
                teamAreas.put(key, r);
            }
            out.putAll(r.value());
        }
        return out;
    }

    @Override
    public List<Item> query(Connection c, Token t, String query, int max) throws ProviderException {
        List<String> ids = wiqlIds(c, t, query, null);
        return items(c, t, ids.subList(0, Math.min(ids.size(), Math.max(1, max))));
    }

    // ----------------------------------------------------------------------------------------------------- items

    @Override
    public List<Item> items(Connection c, Token t, List<String> ids) throws ProviderException {
        List<Item> out = new ArrayList<>();
        for (int i = 0; i < ids.size(); i += BATCH) {
            out.addAll(batch(c, t, ids.subList(i, Math.min(ids.size(), i + BATCH))));
        }
        return out;
    }

    private List<Item> batch(Connection c, Token t, List<String> ids) throws ProviderException {
        if (ids.isEmpty()) {
            return List.of();
        }
        List<Integer> numbers = new ArrayList<>();
        for (String id : ids) {
            try {
                numbers.add(Integer.parseInt(id.strip()));
            } catch (NumberFormatException e) {
                // not an Azure id: left out
            }
        }
        if (numbers.isEmpty()) {
            return List.of();
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("ids", numbers);
        body.put("$expand", "Relations");
        body.put("errorPolicy", "Omit");
        Map<String, Item> byId = new HashMap<>();
        for (JsonNode w : client.post(at(c, "/_apis/wit/workitemsbatch"), t, body).path("value")) {
            if (!w.isNull() && w.has("id")) {
                Item i = AzureMapper.item(w, org(c));
                byId.put(i.extId(), i);
            }
        }
        List<Item> out = new ArrayList<>();
        for (Integer n : numbers) {
            Item i = byId.get(String.valueOf(n));
            if (i != null) {
                out.add(i);
            }
        }
        return out;
    }

    @Override
    public Item item(Connection c, Token t, String extId) throws ProviderException {
        return AzureMapper.item(client.get(at(c, "/_apis/wit/workitems/" + encode(extId) + "?$expand=relations"), t), org(c));
    }

    private String projectOf(Connection c, Token t, String id) throws ProviderException {
        JsonNode w = client.get(at(c, "/_apis/wit/workitems/" + encode(id) + "?fields=System.TeamProject"), t);
        String p = w.path("fields").path("System.TeamProject").asText(null);
        if (p == null) {
            throw new ProviderException(Kind.NOT_FOUND, "Azure DevOps has no work item " + id);
        }
        return p;
    }

    @Override
    public List<Comment> comments(Connection c, Token t, String id) throws ProviderException {
        String project = projectOf(c, t, id);
        List<Comment> out = new ArrayList<>();
        String token = null;
        for (int page = 0; page < 20; page++) {
            String path = "/" + encode(project) + "/_apis/wit/workItems/" + encode(id) + "/comments?$top=200&order=asc"
                    + (token == null ? "" : "&continuationToken=" + encode(token)) + "&api-version=7.1-preview.4";
            JsonNode r = client.get(URI.create(org(c) + path), t);
            for (JsonNode n : r.path("comments")) {
                out.add(AzureMapper.comment(n));
            }
            token = r.path("continuationToken").asText(null);
            if (token == null || token.isBlank()) {
                break;
            }
        }
        return out;
    }

    @Override
    public List<ItemTypeInfo> types(Connection c, Token t) throws ProviderException {
        Set<String> names = new LinkedHashSet<>();
        for (String project : projects(c, t)) {
            for (JsonNode w : client.get(at(c, "/" + encode(project) + "/_apis/wit/workitemtypes"), t).path("value")) {
                names.add(w.path("name").asText());
            }
        }
        return names.stream().map(n -> new ItemTypeInfo(n, !AzureMapper.STANDARD_TYPES.contains(n))).toList();
    }

    @Override
    public List<TypeStates> states(Connection c, Token t) throws ProviderException {
        List<TypeStates> out = new ArrayList<>();
        for (String project : projects(c, t)) {
            for (JsonNode type : client.get(at(c, "/" + encode(project) + "/_apis/wit/workitemtypes"), t).path("value")) {
                List<TypeStates.State> states = new ArrayList<>();
                for (JsonNode s : type.path("states")) {
                    if (!s.path("name").asText("").isBlank()) {
                        states.add(new TypeStates.State(s.path("name").asText(), s.path("category").asText("")));
                    }
                }
                out.add(new TypeStates(project, type.path("name").asText(), states));
            }
        }
        return out;
    }

    /** The type's transitions ("New" -> [Active, Removed]); Azure lists them on the work item type. */
    @Override
    public Map<String, List<String>> transitions(Connection c, Token t, String project, String type) throws ProviderException {
        if (project == null || project.isBlank() || type == null || type.isBlank()) {
            return Map.of();
        }
        JsonNode root = client.get(at(c, "/" + encode(project) + "/_apis/wit/workitemtypes/" + encode(type)), t);
        Map<String, List<String>> out = new LinkedHashMap<>();
        root.path("transitions").fields().forEachRemaining(e -> {
            List<String> to = new ArrayList<>();
            e.getValue().forEach(n -> {
                String s = n.path("to").asText("");
                if (!s.isBlank() && !s.equals(e.getKey())) {
                    to.add(s);
                }
            });
            out.put(e.getKey(), to);
        });
        return out;
    }

    @Override
    public List<String> areas(Connection c, Token t) throws ProviderException {
        List<String> out = new ArrayList<>();
        for (String project : projects(c, t)) {
            JsonNode root = client.get(at(c, "/" + encode(project) + "/_apis/wit/classificationnodes/Areas?$depth=10"), t);
            Deque<JsonNode> todo = new ArrayDeque<>();
            todo.add(root);
            while (!todo.isEmpty() && out.size() < 5000) {
                JsonNode n = todo.poll();
                String path = areaPath(n.path("path").asText(""));
                if (!path.isEmpty()) {
                    out.add(path);
                }
                n.path("children").forEach(todo::add);
            }
        }
        return out;
    }

    @Override
    public List<String> tags(Connection c, Token t) throws ProviderException {
        Set<String> out = new TreeSet<>(String.CASE_INSENSITIVE_ORDER);
        for (String project : projects(c, t)) {
            for (JsonNode n : client.get(URI.create(org(c) + "/" + encode(project) + "/_apis/wit/tags?api-version=7.1-preview.1"), t).path("value")) {
                String name = n.path("name").asText("");
                if (!name.isBlank() && out.size() < 5000) {
                    out.add(name);
                }
            }
        }
        return List.copyOf(out);
    }

    /** "\\Odeysys\\Area\\Payments" -> "Odeysys\\Payments" (the classification path to the work item's Area Path). */
    static String areaPath(String nodePath) {
        String p = nodePath.startsWith("\\") ? nodePath.substring(1) : nodePath;
        String[] parts = p.split("\\\\");
        if (parts.length >= 2 && parts[1].equalsIgnoreCase("Area")) {
            List<String> keep = new ArrayList<>();
            keep.add(parts[0]);
            for (int i = 2; i < parts.length; i++) {
                keep.add(parts[i]);
            }
            return String.join("\\", keep);
        }
        return p;
    }

    // ------------------------------------------------------------------------------------------------------ tree

    @Override
    public List<TreeRef> tree(Connection c, Token t, String rootId, int max) throws ProviderException {
        Item root = item(c, t, rootId);
        List<TreeRef> out = new ArrayList<>();
        // ancestors: walk Parent up (at most 20 hops)
        String parent = parentOf(root);
        int depth = -1;
        Set<String> seen = new LinkedHashSet<>(List.of(rootId));
        while (parent != null && depth >= -20 && seen.add(parent)) {
            out.add(new TreeRef(parent, TreeRef.ANCESTOR, depth, null, null));
            Item up;
            try {
                up = item(c, t, parent);
            } catch (ProviderException e) {
                if (e.kind() == Kind.NOT_FOUND || e.kind() == Kind.TOKEN_REJECTED) {
                    break; // a parent this token may not read: the walk stops there
                }
                throw e;
            }
            parent = parentOf(up);
            depth--;
        }
        // fix each ancestor's own parent now that the chain is known
        for (int i = 0; i < out.size(); i++) {
            TreeRef a = out.get(i);
            String above = i + 1 < out.size() ? out.get(i + 1).id() : null;
            out.set(i, new TreeRef(a.id(), a.relation(), a.depth(), above, null));
        }
        // descendants: one recursive link query
        String wiql = "SELECT [System.Id] FROM WorkItemLinks WHERE [Source].[System.Id] = " + Integer.parseInt(rootId.strip())
                + " AND [System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward' MODE (Recursive)";
        String path = root.project() == null ? "/_apis/wit/wiql" : "/" + encode(root.project()) + "/_apis/wit/wiql";
        JsonNode links = client.post(at(c, path), t, Map.of("query", wiql));
        Map<String, Integer> depthOf = new HashMap<>();
        depthOf.put(rootId, 0);
        for (JsonNode r : links.path("workItemRelations")) {
            if (r.path("source").isMissingNode() || r.path("source").isNull()) {
                continue; // the root itself
            }
            String from = r.path("source").path("id").asText();
            String to = r.path("target").path("id").asText();
            int d = depthOf.getOrDefault(from, 0) + 1;
            if (depthOf.putIfAbsent(to, d) == null && seen.add(to)) {
                out.add(new TreeRef(to, TreeRef.DESCENDANT, d, from, null));
                if (out.size() > max) {
                    return out;
                }
            }
        }
        // one hop of the root's other links
        for (Link l : root.links()) {
            if (l.kind().equals("Parent") || l.kind().equals("Child") || !l.toId().matches("\\d+")) {
                continue;
            }
            if (seen.add(l.toId())) {
                out.add(new TreeRef(l.toId(), TreeRef.LINK, 1, rootId, l.kind()));
                if (out.size() > max) {
                    return out;
                }
            }
        }
        return out;
    }

    private static String parentOf(Item i) {
        for (Link l : i.links()) {
            if ("Parent".equals(l.kind()) && l.toId().matches("\\d+")) {
                return l.toId();
            }
        }
        String f = i.fields().get("System.Parent");
        return f == null || f.isBlank() ? null : f;
    }

    // ------------------------------------------------------------------------------------------------ identities

    @Override
    public Person whoAmI(Connection c, Token t) throws ProviderException {
        JsonNode r = client.get(URI.create(org(c) + "/_apis/connectionData"), t);
        JsonNode u = r.path("authenticatedUser");
        String id = u.path("id").asText(null);
        if (id == null) {
            throw new ProviderException(Kind.TOKEN_REJECTED, "Azure DevOps did not say whose token this is");
        }
        String name = u.path("providerDisplayName").asText(u.path("customDisplayName").asText(id));
        String mail = u.path("properties").path("Account").path("$value").asText(null);
        return new Person(id, name, mail);
    }

    @Override
    public List<Person> peopleById(Connection c, Token t, Collection<String> ids) throws ProviderException {
        if (ids.isEmpty()) {
            return List.of();
        }
        JsonNode r = client.get(URI.create(service(c, "vssps") + "/_apis/identities?identityIds=" + encode(String.join(",", ids)) + "&" + API), t);
        List<Person> out = new ArrayList<>();
        for (JsonNode n : r.path("value")) {
            String id = n.path("id").asText(null);
            if (id == null) {
                continue;
            }
            String name = n.path("providerDisplayName").asText(n.path("customDisplayName").asText(id));
            String mail = n.path("properties").path("Mail").path("$value").asText(n.path("properties").path("Account").path("$value").asText(null));
            out.add(new Person(id, name, mail));
        }
        return out;
    }

    // ---------------------------------------------------------------------------------------------- teams and people

    private record TeamRef(String project, String id, String name) {
    }

    private List<TeamRef> teams(Connection c, Token t) throws ProviderException {
        List<TeamRef> out = new ArrayList<>();
        Set<String> wanted = Set.copyOf(c.scope().teams());
        for (String project : projects(c, t)) {
            for (JsonNode team : paged(c, t, "/_apis/projects/" + encode(project) + "/teams", 500)) {
                String name = team.path("name").asText();
                if (wanted.isEmpty() || wanted.contains(name)) {
                    out.add(new TeamRef(project, team.path("id").asText(), name));
                }
            }
        }
        return out;
    }

    @Override
    public List<Squad> squads(Connection c, Token t) throws ProviderException {
        List<Squad> out = new ArrayList<>();
        for (TeamRef team : teams(c, t)) {
            List<String> members = new ArrayList<>();
            for (JsonNode m : members(c, t, team)) {
                members.add(m.path("identity").path("id").asText());
            }
            out.add(new Squad(team.id(), team.name(), team.project(), members));
        }
        return out;
    }

    private List<JsonNode> members(Connection c, Token t, TeamRef team) throws ProviderException {
        return paged(c, t, "/_apis/projects/" + encode(team.project()) + "/teams/" + encode(team.id()) + "/members", 1000);
    }

    /** Every row of a list, page after page ($top/$skip) until a short page - none silently left out. */
    private List<JsonNode> paged(Connection c, Token t, String path, int top) throws ProviderException {
        List<JsonNode> out = new ArrayList<>();
        for (int skip = 0; skip < 1_000_000; skip += top) {
            JsonNode page = client.get(at(c, path + "?$top=" + top + "&$skip=" + skip), t).path("value");
            page.forEach(out::add);
            if (page.size() < top) {
                break;
            }
        }
        return out;
    }

    @Override
    public List<Person> people(Connection c, Token t) throws ProviderException {
        Map<String, Person> out = new LinkedHashMap<>();
        for (TeamRef team : teams(c, t)) {
            for (JsonNode m : members(c, t, team)) {
                JsonNode id = m.path("identity");
                out.putIfAbsent(id.path("id").asText(), new Person(id.path("id").asText(), id.path("displayName").asText(),
                        id.path("uniqueName").asText(null)));
            }
        }
        return List.copyOf(out.values());
    }

    @Override
    public List<Sprint> sprints(Connection c, Token t) throws ProviderException {
        List<Sprint> out = new ArrayList<>();
        for (TeamRef team : teams(c, t)) {
            JsonNode it = client.get(at(c, "/" + encode(team.project()) + "/" + encode(team.id()) + "/_apis/work/teamsettings/iterations"), t);
            for (JsonNode s : it.path("value")) {
                out.add(new Sprint(s.path("id").asText(), s.path("path").asText(s.path("name").asText()), team.project() + "\\" + team.name(),
                        AzureMapper.instant(s.path("attributes").path("startDate").asText(null)),
                        AzureMapper.instant(s.path("attributes").path("finishDate").asText(null))));
            }
        }
        return out;
    }

    @Override
    public List<ProviderBoard> boards(Connection c, Token t) throws ProviderException {
        List<ProviderBoard> out = new ArrayList<>();
        for (TeamRef team : teams(c, t)) {
            String base = "/" + encode(team.project()) + "/" + encode(team.id()) + "/_apis/work/boards";
            for (JsonNode b : client.get(at(c, base), t).path("value")) {
                List<String> columns = new ArrayList<>();
                JsonNode detail = client.get(at(c, base + "/" + encode(b.path("id").asText())), t);
                for (JsonNode col : detail.path("columns")) {
                    columns.add(col.path("name").asText());
                }
                out.add(new ProviderBoard(b.path("id").asText(), b.path("name").asText(), team.project(), team.name(), columns));
            }
        }
        return out;
    }

    // ---------------------------------------------------------------------------------------- revisions, attachments

    @Override
    public List<Revision> revisions(Connection c, Token t, String extId) throws ProviderException {
        List<Revision> out = new ArrayList<>();
        for (JsonNode u : paged(c, t, "/_apis/wit/workItems/" + encode(extId) + "/updates", 200)) {
            Revision r = AzureMapper.revision(u);
            if (!r.changes().isEmpty()) {
                out.add(r);
            }
        }
        return out;
    }

    @Override
    public List<Attachment> attachments(Connection c, Token t, String extId, boolean withData) throws ProviderException {
        JsonNode w = client.get(at(c, "/_apis/wit/workitems/" + encode(extId) + "?$expand=relations"), t);
        List<Attachment> out = new ArrayList<>();
        long total = 0;
        for (Attachment a : listed(w)) {
            byte[] data = null;
            if (withData && ours(c, a.url()) && a.size() >= 0 && a.size() <= Attachment.MAX_BYTES && total + a.size() <= Attachment.MAX_PER_ITEM) {
                data = client.download(a.url(), t, Attachment.MAX_BYTES);
                if (data != null) {
                    total += data.length;
                }
            }
            out.add(new Attachment(a.name(), a.mime(), a.size(), a.url(), data));
        }
        return out;
    }

    /** The token goes only to the org's own host - never to a link a relation names elsewhere. */
    static boolean ours(Connection c, URI url) {
        if (url == null || url.getHost() == null || !url.getHost().equalsIgnoreCase(c.baseUrl().getHost())) {
            return false;
        }
        boolean local = "localhost".equalsIgnoreCase(url.getHost()) || "127.0.0.1".equals(url.getHost());
        if (!"https".equalsIgnoreCase(url.getScheme()) && !local) {
            return false; // never Basic auth in clear text
        }
        String org = c.baseUrl().getPath() == null ? "" : c.baseUrl().getPath().replaceAll("/+$", "");
        String path = url.getPath() == null ? "" : url.getPath();
        return org.isEmpty() || path.equalsIgnoreCase(org) || path.toLowerCase(java.util.Locale.ROOT).startsWith(org.toLowerCase(java.util.Locale.ROOT) + "/");
    }

    @Override
    public byte[] content(Connection c, Token t, Attachment a) throws ProviderException {
        if (!ours(c, a.url())) {
            return null;
        }
        return client.download(a.url(), t, Attachment.MAX_BYTES);
    }

    private static List<Attachment> listed(JsonNode w) {
        List<Attachment> out = new ArrayList<>();
        for (JsonNode r : w.path("relations")) {
            if (!"AttachedFile".equals(r.path("rel").asText())) {
                continue;
            }
            String name = r.path("attributes").path("name").asText("attachment");
            try {
                out.add(new Attachment(name, mime(name), r.path("attributes").path("resourceSize").asLong(-1), URI.create(r.path("url").asText()), null));
            } catch (IllegalArgumentException e) {
                // a relation with a bad link is left out
            }
        }
        return out;
    }

    static String mime(String name) {
        String n = name.toLowerCase(Locale.ROOT);
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".gif")) return "image/gif";
        if (n.endsWith(".pdf")) return "application/pdf";
        if (n.endsWith(".md")) return "text/markdown";
        if (n.endsWith(".txt") || n.endsWith(".log")) return "text/plain";
        if (n.endsWith(".json")) return "application/json";
        if (n.endsWith(".html") || n.endsWith(".htm")) return "text/html";
        return "application/octet-stream";
    }

    @Override
    public List<Attachment> listedIn(Item item) {
        if (item.nativeJson() == null || item.nativeJson().isBlank()) {
            return List.of();
        }
        try {
            return listed(json.readTree(item.nativeJson()));
        } catch (java.io.IOException e) {
            return List.of();
        }
    }

    // ----------------------------------------------------------------------------------------------------------- seed

    @Override
    public SeedPart seed(Item item) {
        Map<String, String> f = item.fields();
        return new SeedPart(f.get("System.Description"), f.get("Microsoft.VSTS.TCM.ReproSteps"), f.get("Microsoft.VSTS.Common.AcceptanceCriteria"),
                null);
    }

    // --------------------------------------------------------------------------------------------------------- writes

    private static Map<String, Object> op(String op, String path, Object value) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("op", op);
        m.put("path", path);
        if (value != null) {
            m.put("value", value);
        }
        return m;
    }

    @Override
    public String comment(Connection c, Token t, String id, String text) throws ProviderException {
        String project = projectOf(c, t, id);
        JsonNode r = client.post(URI.create(org(c) + "/" + encode(project) + "/_apis/wit/workItems/" + encode(id)
                + "/comments?format=markdown&api-version=7.1-preview.4"), t, Map.of("text", markdownMentions(text)));
        return r.path("id").asText(null);
    }

    @Override
    public void moveState(Connection c, Token t, String id, String state) throws ProviderException {
        client.patch(at(c, "/_apis/wit/workitems/" + encode(id)), t, List.of(op("add", "/fields/System.State", state)));
    }

    @Override
    public void setField(Connection c, Token t, String id, String field, String value) throws ProviderException {
        client.patch(at(c, "/_apis/wit/workitems/" + encode(id)), t, List.of(op("add", "/fields/" + field, value == null ? "" : value)));
    }

    @Override
    public String create(Connection c, Token t, NewItem item) throws ProviderException {
        JsonNode r = client.postPatch(createUri(c, t, item, false), t, createOps(c, item));
        String id = r.path("id").asText(null);
        if (id == null) {
            throw new ProviderException(Kind.BAD_RESPONSE, "Azure DevOps created no work item");
        }
        return id;
    }

    /** Azure's validateOnly (specs/038 G-1): the same request, checked by the project's own rules, nothing saved. */
    @Override
    public boolean validateCreate(Connection c, Token t, NewItem item) throws ProviderException {
        client.postPatch(createUri(c, t, item, true), t, createOps(c, item));
        return true;
    }

    private URI createUri(Connection c, Token t, NewItem item, boolean validateOnly) throws ProviderException {
        String project = item.project() != null && !item.project().isBlank() ? item.project()
                : projects(c, t).stream().findFirst().orElseThrow(() -> new ProviderException(Kind.BAD_RESPONSE, "No project to create the item in"));
        return at(c, "/" + encode(project) + "/_apis/wit/workitems/$" + encode(item.type()) + (validateOnly ? "?validateOnly=true" : ""));
    }

    /** Every field, the parent, the links and the tags of a new item - one JSON-Patch (specs/038 FR-1). */
    List<Map<String, Object>> createOps(Connection c, NewItem item) {
        List<Map<String, Object>> ops = new ArrayList<>();
        ops.add(op("add", "/fields/System.Title", item.title()));
        if (item.description() != null && !item.description().isBlank()) {
            ops.add(op("add", "/fields/System.Description", html(item.description())));
        }
        if (item.area() != null && !item.area().isBlank()) {
            ops.add(op("add", "/fields/System.AreaPath", item.area()));
        }
        if (item.iteration() != null && !item.iteration().isBlank()) {
            ops.add(op("add", "/fields/System.IterationPath", item.iteration()));
        }
        if (item.assignee() != null && !item.assignee().isBlank()) {
            ops.add(op("add", "/fields/System.AssignedTo", item.assignee()));
        }
        Set<String> tags = new LinkedHashSet<>(item.tags());
        for (Map.Entry<String, String> f : item.fields().entrySet()) {
            if (f.getKey().equalsIgnoreCase("System.Tags")) {
                for (String x : f.getValue().split(";")) {
                    if (!x.isBlank()) {
                        tags.add(x.strip());
                    }
                }
                continue;
            }
            ops.add(op("add", "/fields/" + f.getKey(), fieldValue(f.getKey(), f.getValue())));
        }
        if (!tags.isEmpty()) {
            ops.add(op("add", "/fields/System.Tags", String.join("; ", tags)));
        }
        if (item.parent() != null && !item.parent().isBlank()) {
            ops.add(op("add", "/relations/-", relation(c, "Parent", item.parent().strip())));
        }
        for (Link l : item.links()) {
            ops.add(op("add", "/relations/-", relation(c, l.kind(), l.toId())));
        }
        return ops;
    }

    @Override
    public void update(Connection c, Token t, String id, ItemUpdate change) throws ProviderException {
        client.patch(at(c, "/_apis/wit/workitems/" + encode(id)), t, updateOps(c, t, id, change));
    }

    @Override
    public boolean validateUpdate(Connection c, Token t, String id, ItemUpdate change) throws ProviderException {
        client.patch(at(c, "/_apis/wit/workitems/" + encode(id) + "?validateOnly=true"), t, updateOps(c, t, id, change));
        return true;
    }

    /**
     * One edit as a JSON-Patch against the item's current revision ({@code test /rev}: an item changed meanwhile is
     * refused, never overwritten): fields, state, tags merged with the item's own, relations removed from the highest
     * index down (each remove shifts the ones after it), then added.
     */
    List<Map<String, Object>> updateOps(Connection c, Token t, String id, ItemUpdate change) throws ProviderException {
        JsonNode w = client.get(at(c, "/_apis/wit/workitems/" + encode(id) + "?$expand=relations"), t);
        List<Map<String, Object>> ops = new ArrayList<>();
        ops.add(op("test", "/rev", w.path("rev").asInt()));
        for (Map.Entry<String, String> f : change.fields().entrySet()) {
            if (f.getKey().equalsIgnoreCase("System.Tags")) {
                continue; // tags go through addTags / removeTags, merged below
            }
            String v = f.getValue();
            if (v == null || v.isEmpty()) {
                if (w.path("fields").has(f.getKey())) {
                    ops.add(op("remove", "/fields/" + f.getKey(), null));
                }
            } else {
                ops.add(op("add", "/fields/" + f.getKey(), fieldValue(f.getKey(), v)));
            }
        }
        if (change.state() != null && !change.state().isBlank()) {
            ops.add(op("add", "/fields/System.State", change.state().strip()));
        }
        if (!change.addTags().isEmpty() || !change.removeTags().isEmpty()) {
            Set<String> tags = new LinkedHashSet<>();
            for (String x : w.path("fields").path("System.Tags").asText("").split(";")) {
                if (!x.isBlank()) {
                    tags.add(x.strip());
                }
            }
            for (String x : change.removeTags()) {
                tags.removeIf(y -> y.equalsIgnoreCase(x.strip()));
            }
            for (String x : change.addTags()) {
                if (tags.stream().noneMatch(y -> y.equalsIgnoreCase(x.strip()))) {
                    tags.add(x.strip());
                }
            }
            ops.add(op("add", "/fields/System.Tags", String.join("; ", tags)));
        }
        List<JsonNode> rels = new ArrayList<>();
        w.path("relations").forEach(rels::add);
        TreeSet<Integer> removes = new TreeSet<>(java.util.Comparator.reverseOrder());
        for (int i = 0; i < rels.size(); i++) {
            String rel = rels.get(i).path("rel").asText();
            String target = rels.get(i).path("url").asText();
            String other = target.substring(target.lastIndexOf('/') + 1);
            if (change.parent() != null && rel.equals("System.LinkTypes.Hierarchy-Reverse")) {
                removes.add(i);
            }
            for (Link l : change.removeLinks()) {
                if (rel.equals(relName(l.kind())) && other.equals(l.toId().strip())) {
                    removes.add(i);
                }
            }
        }
        for (int i : removes) {
            ops.add(op("remove", "/relations/" + i, null));
        }
        if (change.parent() != null && !change.parent().isBlank()) {
            ops.add(op("add", "/relations/-", relation(c, "Parent", change.parent().strip())));
        }
        for (Link l : change.addLinks()) {
            ops.add(op("add", "/relations/-", relation(c, l.kind(), l.toId())));
        }
        return ops;
    }

    /** A relation to another work item, by its Alfred kind ("Parent", "Related", "Predecessor"...). */
    private static Map<String, Object> relation(Connection c, String kind, String toId) {
        Map<String, Object> rel = new LinkedHashMap<>();
        rel.put("rel", relName(kind));
        rel.put("url", org(c) + "/_apis/wit/workItems/" + encode(toId.strip()));
        return rel;
    }

    /** The Azure link type of an Alfred link kind; an unknown one is refused, never guessed. */
    static String relName(String kind) {
        String k = kind == null ? "" : kind.strip().toLowerCase(Locale.ROOT).replace("-", " ").replace("_", " ");
        return switch (k) {
            case "parent" -> "System.LinkTypes.Hierarchy-Reverse";
            case "child" -> "System.LinkTypes.Hierarchy-Forward";
            case "related" -> "System.LinkTypes.Related";
            case "successor" -> "System.LinkTypes.Dependency-Forward";
            case "predecessor" -> "System.LinkTypes.Dependency-Reverse";
            case "duplicate" -> "System.LinkTypes.Duplicate-Forward";
            case "duplicate of" -> "System.LinkTypes.Duplicate-Reverse";
            case "tested by" -> "Microsoft.VSTS.Common.TestedBy-Forward";
            case "tests" -> "Microsoft.VSTS.Common.TestedBy-Reverse";
            default -> throw new IllegalArgumentException("Unknown link kind " + kind
                    + " - use Parent, Child, Related, Predecessor, Successor, Duplicate, Duplicate of, Tested by or Tests");
        };
    }

    /** HTML fields keep Alfred's mentions as Azure's. */
    private static Object fieldValue(String field, String value) {
        if (field.equalsIgnoreCase("System.Description") || field.equalsIgnoreCase("Microsoft.VSTS.TCM.ReproSteps")
                || field.equalsIgnoreCase("Microsoft.VSTS.Common.AcceptanceCriteria")) {
            return html(value);
        }
        return value;
    }

    /** A type's fields with what is required and allowed (specs/038 FR-14): one read of the type, one of the project's fields. */
    @Override
    public List<FieldInfo> fields(Connection c, Token t, String project, String type) throws ProviderException {
        JsonNode typeFields = client.get(at(c, "/" + encode(project) + "/_apis/wit/workitemtypes/" + encode(type) + "/fields?$expand=all"), t);
        Map<String, JsonNode> meta = new HashMap<>();
        for (JsonNode f : client.get(at(c, "/" + encode(project) + "/_apis/wit/fields"), t).path("value")) {
            meta.put(f.path("referenceName").asText(), f);
        }
        List<FieldInfo> out = new ArrayList<>();
        for (JsonNode f : typeFields.path("value")) {
            String ref = f.path("referenceName").asText();
            JsonNode m = meta.get(ref);
            List<String> allowed = new ArrayList<>();
            f.path("allowedValues").forEach(v -> allowed.add(v.isObject() ? v.path("displayName").asText(v.toString()) : v.asText()));
            JsonNode def = f.path("defaultValue");
            out.add(new FieldInfo(ref, f.path("name").asText(ref), m == null ? "" : m.path("type").asText(""), f.path("alwaysRequired").asBoolean(false),
                    m != null && m.path("readOnly").asBoolean(false), allowed, def.isMissingNode() || def.isNull() ? null : def.asText()));
        }
        return out;
    }

    /** Description is an HTML field: text that is not HTML already is escaped, its lines kept; Alfred mentions become Azure's. */
    static String html(String text) {
        String s = text.strip();
        if (s.startsWith("<") && s.endsWith(">")) {
            return replaceMentions(s, true);
        }
        StringBuilder out = new StringBuilder("<div>");
        Matcher m = MENTION.matcher(s);
        int at = 0;
        while (m.find()) {
            out.append(escape(s.substring(at, m.start()))).append(mention(m, true));
            at = m.end();
        }
        out.append(escape(s.substring(at)));
        return out.append("</div>").toString();
    }

    private static String escape(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\r\n", "\n").replace("\n", "<br>");
    }

    /** An Alfred mention in board text: {@code @[type:ref|label]}. */
    private static final Pattern MENTION = Pattern.compile("@\\[([a-z-]+):([^|\\]]*)(?:\\|([^\\]]*))?]");
    private static final Pattern GUID = Pattern.compile("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}");

    /**
     * A markdown comment with Alfred's mentions in Azure's words: a person whose id is an Azure identity becomes
     * {@code @<guid>} (Azure shows the name and notifies them), a work item {@code #id}, anything else (a card, a call)
     * its label - Azure cannot open Alfred's own references.
     */
    static String markdownMentions(String text) {
        return text == null ? null : replaceMentions(text, false);
    }

    private static String replaceMentions(String text, boolean html) {
        Matcher m = MENTION.matcher(text);
        StringBuilder out = new StringBuilder();
        while (m.find()) {
            m.appendReplacement(out, Matcher.quoteReplacement(mention(m, html)));
        }
        m.appendTail(out);
        return out.toString();
    }

    private static String mention(Matcher m, boolean html) {
        String type = m.group(1);
        String ref = m.group(2);
        String id = ref.contains("/") ? ref.substring(ref.indexOf('/') + 1) : ref;
        String label = m.group(3) == null || m.group(3).isBlank() ? id : m.group(3).strip();
        if ("person".equals(type)) {
            if (GUID.matcher(id).matches()) {
                return html ? "<a href=\"#\" data-vss-mention=\"version:2.0," + id + "\">@" + escape(label) + "</a>" : "@<" + id + ">";
            }
            return "@" + (html ? escape(label) : label);
        }
        if ("workitem".equals(type) && id.matches("\\d+")) {
            return "#" + id;
        }
        return html ? escape(label) : label;
    }

    @Override
    public void hyperlink(Connection c, Token t, String id, URI url, String label, boolean add) throws ProviderException {
        if (add) {
            Map<String, Object> rel = new LinkedHashMap<>();
            rel.put("rel", "Hyperlink");
            rel.put("url", url.toString());
            rel.put("attributes", Map.of("comment", label == null ? "Alfred" : label));
            client.patch(at(c, "/_apis/wit/workitems/" + encode(id)), t, List.of(op("add", "/relations/-", rel)));
            return;
        }
        JsonNode w = client.get(at(c, "/_apis/wit/workitems/" + encode(id) + "?$expand=relations"), t);
        int i = 0;
        for (JsonNode r : w.path("relations")) {
            if ("Hyperlink".equals(r.path("rel").asText()) && url.toString().equals(r.path("url").asText())) {
                client.patch(at(c, "/_apis/wit/workitems/" + encode(id)), t, List.of(op("test", "/rev", w.path("rev").asInt()),
                        op("remove", "/relations/" + i, null)));
                return;
            }
            i++;
        }
        // not there any more: nothing to remove
    }

    @Override
    public void tag(Connection c, Token t, String id, String tag, boolean add) throws ProviderException {
        JsonNode w = client.get(at(c, "/_apis/wit/workitems/" + encode(id) + "?fields=System.Tags"), t);
        Set<String> tags = new LinkedHashSet<>();
        for (String s : w.path("fields").path("System.Tags").asText("").split(";")) {
            if (!s.isBlank()) {
                tags.add(s.strip());
            }
        }
        boolean had = tags.stream().anyMatch(x -> x.equalsIgnoreCase(tag));
        if (add == had) {
            return;
        }
        if (add) {
            tags.add(tag);
        } else {
            tags.removeIf(x -> x.equalsIgnoreCase(tag));
        }
        client.patch(at(c, "/_apis/wit/workitems/" + encode(id)), t, List.of(op("add", "/fields/System.Tags", String.join("; ", tags))));
    }

    @Override
    public void attach(Connection c, Token t, String id, String name, byte[] data) throws ProviderException {
        JsonNode up = client.postBytes(at(c, "/_apis/wit/attachments?fileName=" + encode(name)), t, data);
        String url = up.path("url").asText(null);
        if (url == null) {
            throw new ProviderException(Kind.BAD_RESPONSE, "Azure DevOps did not take the file " + name);
        }
        Map<String, Object> rel = new LinkedHashMap<>();
        rel.put("rel", "AttachedFile");
        rel.put("url", url);
        client.patch(at(c, "/_apis/wit/workitems/" + encode(id)), t, List.of(op("add", "/relations/-", rel)));
    }

    // ----------------------------------------------------------------------------------------------------------- hook

    /** A service hook's body: {@code resource.workItemId} (updated, commented) or {@code resource.id} (created). Nothing else. */
    @Override
    public List<String> ids(String body) {
        try {
            JsonNode r = json.readTree(body).path("resource");
            String id = r.path("workItemId").asText(null);
            if (id == null || id.isBlank()) {
                id = r.path("id").asText(null);
            }
            return id != null && id.matches("\\d{1,9}") ? List.of(id) : List.of();
        } catch (java.io.IOException | RuntimeException e) {
            return List.of();
        }
    }
}
