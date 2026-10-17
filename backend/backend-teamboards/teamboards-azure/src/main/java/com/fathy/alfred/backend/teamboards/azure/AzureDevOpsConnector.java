package com.fathy.alfred.backend.teamboards.azure;

import com.fasterxml.jackson.databind.JsonNode;
import com.fathy.alfred.backend.teamboards.spi.AttachmentsReader;
import com.fathy.alfred.backend.teamboards.spi.BoardsReader;
import com.fathy.alfred.backend.teamboards.spi.Connector;
import com.fathy.alfred.backend.teamboards.spi.ProviderException;
import com.fathy.alfred.backend.teamboards.spi.ProviderWords;
import com.fathy.alfred.backend.teamboards.spi.RevisionsReader;
import com.fathy.alfred.backend.teamboards.spi.SeedContributor;
import com.fathy.alfred.backend.teamboards.spi.SprintsReader;
import com.fathy.alfred.backend.teamboards.spi.SquadsReader;
import com.fathy.alfred.backend.teamboards.spi.model.Attachment;
import com.fathy.alfred.backend.teamboards.spi.model.Connection;
import com.fathy.alfred.backend.teamboards.spi.model.Item;
import com.fathy.alfred.backend.teamboards.spi.model.ItemTypeInfo;
import com.fathy.alfred.backend.teamboards.spi.model.Person;
import com.fathy.alfred.backend.teamboards.spi.model.ProviderBoard;
import com.fathy.alfred.backend.teamboards.spi.model.Revision;
import com.fathy.alfred.backend.teamboards.spi.model.SeedPart;
import com.fathy.alfred.backend.teamboards.spi.model.Sprint;
import com.fathy.alfred.backend.teamboards.spi.model.Squad;
import com.fathy.alfred.backend.teamboards.spi.model.Token;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Consumer;

import static com.fathy.alfred.backend.teamboards.azure.AzureClient.API;
import static com.fathy.alfred.backend.teamboards.azure.AzureMapper.encode;
import static com.fathy.alfred.backend.teamboards.azure.AzureMapper.text;

/**
 * Azure DevOps, read-only (specs/027 US7, research R9). The connection's base URL is the organisation
 * ({@code https://dev.azure.com/<org>}); its scope names the projects and teams (none: every project the token sees).
 * Changed items come from WIQL on {@code System.ChangedDate}, then {@code workitemsbatch} 200 at a time with relations.
 */
@Component
public class AzureDevOpsConnector implements Connector, BoardsReader, SprintsReader, SquadsReader, RevisionsReader, AttachmentsReader,
        SeedContributor {

    static final int BATCH = 200;
    /** WIQL answers at most 20,000 ids: a bigger first fetch goes on in date windows. */
    static final int WIQL_MAX = 19_999;

    private final AzureClient client;

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

    private static URI org(Connection c) {
        String s = c.baseUrl().toString();
        return URI.create(s.endsWith("/") ? s.substring(0, s.length() - 1) : s);
    }

    private static URI at(Connection c, String path) {
        return URI.create(org(c) + path + (path.contains("?") ? "&" : "?") + API);
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

    // ---------------------------------------------------------------------------------------------------------- items

    @Override
    public void changedItems(Connection c, Token t, Instant since, Consumer<List<Item>> page) throws ProviderException {
        for (String project : projects(c, t)) {
            Instant from = since;
            while (true) {
                String where = "[System.TeamProject] = '" + project.replace("'", "''") + "'"
                        + (from == null ? "" : " AND [System.ChangedDate] >= '" + from.truncatedTo(ChronoUnit.SECONDS) + "'");
                String wiql = "SELECT [System.Id], [System.ChangedDate] FROM WorkItems WHERE " + where + " ORDER BY [System.ChangedDate] ASC";
                JsonNode found = client.post(at(c, "/" + encode(project) + "/_apis/wit/wiql?$top=" + (WIQL_MAX + 1)), t, Map.of("query", wiql));
                List<Integer> ids = new ArrayList<>();
                for (JsonNode w : found.path("workItems")) {
                    ids.add(w.path("id").asInt());
                }
                Instant last = null;
                for (int i = 0; i < ids.size(); i += BATCH) {
                    List<Item> items = batch(c, t, ids.subList(i, Math.min(ids.size(), i + BATCH)));
                    for (Item item : items) {
                        if (item.changedAt() != null && (last == null || item.changedAt().isAfter(last))) {
                            last = item.changedAt();
                        }
                    }
                    page.accept(items);
                }
                // a full window: the next one starts at the newest change read (items read twice are upserts, not changes)
                if (ids.size() <= WIQL_MAX || last == null || (from != null && !last.isAfter(from))) {
                    break;
                }
                from = last;
            }
        }
    }

    private List<Item> batch(Connection c, Token t, List<Integer> ids) throws ProviderException {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("ids", ids);
        body.put("$expand", "Relations");
        body.put("errorPolicy", "Omit");
        List<Item> out = new ArrayList<>();
        for (JsonNode w : client.post(at(c, "/_apis/wit/workitemsbatch"), t, body).path("value")) {
            if (!w.isNull() && w.has("id")) {
                out.add(AzureMapper.item(w, org(c)));
            }
        }
        return out;
    }

    @Override
    public Item item(Connection c, Token t, String extId) throws ProviderException {
        return AzureMapper.item(client.get(at(c, "/_apis/wit/workitems/" + encode(extId) + "?$expand=relations"), t), org(c));
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
                out.add(new Sprint(s.path("id").asText(), s.path("path").asText(s.path("name").asText()), team.name(),
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
        for (JsonNode r : w.path("relations")) {
            if (!"AttachedFile".equals(r.path("rel").asText())) {
                continue;
            }
            String name = r.path("attributes").path("name").asText("attachment");
            long size = r.path("attributes").path("resourceSize").asLong(-1);
            URI url;
            try {
                url = URI.create(r.path("url").asText());
            } catch (IllegalArgumentException e) {
                continue; // a relation with a bad link: nothing to list or fetch
            }
            byte[] data = null;
            // the token goes only to the org's own host - never to a link a relation names elsewhere
            boolean ours = url.getHost() != null && url.getHost().equalsIgnoreCase(c.baseUrl().getHost());
            if (withData && ours && size >= 0 && size <= Attachment.MAX_BYTES && total + size <= Attachment.MAX_PER_ITEM) {
                data = client.download(url, t, Attachment.MAX_BYTES);
                if (data != null) {
                    total += data.length;
                }
            }
            out.add(new Attachment(name, mime(name), size, url, data));
        }
        return out;
    }

    static String mime(String name) {
        String n = name.toLowerCase(java.util.Locale.ROOT);
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".gif")) return "image/gif";
        if (n.endsWith(".pdf")) return "application/pdf";
        if (n.endsWith(".md")) return "text/markdown";
        if (n.endsWith(".txt") || n.endsWith(".log")) return "text/plain";
        if (n.endsWith(".json")) return "application/json";
        return "application/octet-stream";
    }

    // ----------------------------------------------------------------------------------------------------------- seed

    @Override
    public SeedPart seed(Item item) {
        Map<String, String> f = item.fields();
        return new SeedPart(f.get("System.Description"), f.get("Microsoft.VSTS.TCM.ReproSteps"), f.get("Microsoft.VSTS.Common.AcceptanceCriteria"),
                null);
    }
}
