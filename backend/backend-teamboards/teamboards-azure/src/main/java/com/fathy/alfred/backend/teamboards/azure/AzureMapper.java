package com.fathy.alfred.backend.teamboards.azure;

import com.fasterxml.jackson.databind.JsonNode;
import com.fathy.alfred.backend.teamboards.spi.model.Comment;
import com.fathy.alfred.backend.teamboards.spi.model.FieldChange;
import com.fathy.alfred.backend.teamboards.spi.model.Item;
import com.fathy.alfred.backend.teamboards.spi.model.Link;
import com.fathy.alfred.backend.teamboards.spi.model.Person;
import com.fathy.alfred.backend.teamboards.spi.model.Revision;

import java.net.URI;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Azure DevOps JSON to the neutral SPI records (contracts/connector-spi.md). Pure, so it is tested on recorded fixtures. */
final class AzureMapper {

    /** The process templates' own types; anything else ("Meeting", "Thread"...) is custom. */
    static final Set<String> STANDARD_TYPES = Set.of("Bug", "Task", "User Story", "Feature", "Epic", "Issue", "Test Case", "Test Plan",
            "Test Suite", "Product Backlog Item", "Impediment", "Requirement", "Change Request", "Review", "Risk", "Shared Steps",
            "Shared Parameter", "Code Review Request", "Code Review Response", "Feedback Request", "Feedback Response");

    private AzureMapper() {
    }

    static String text(JsonNode n) {
        if (n == null || n.isNull() || n.isMissingNode()) {
            return null;
        }
        if (n.isObject()) { // an identity: {displayName, uniqueName, ...}
            JsonNode name = n.get("displayName");
            return name == null ? n.toString() : name.asText();
        }
        return n.isTextual() ? n.asText() : n.toString();
    }

    static Instant instant(String s) {
        if (s == null || s.isBlank()) {
            return null;
        }
        try {
            return Instant.parse(s);
        } catch (DateTimeParseException e) {
            return null;
        }
    }

    /** The last part of a path: "Odeysys\\Payments\\Refunds" -> "Refunds". */
    static String leaf(String path) {
        if (path == null) {
            return null;
        }
        int at = path.lastIndexOf('\\');
        return at < 0 ? path : path.substring(at + 1);
    }

    static Item item(JsonNode w, URI org) {
        JsonNode f = w.path("fields");
        String id = w.path("id").asText();
        String project = text(f.get("System.TeamProject"));
        String type = text(f.get("System.WorkItemType"));
        Map<String, String> fields = new LinkedHashMap<>();
        Iterator<Map.Entry<String, JsonNode>> it = f.fields();
        while (it.hasNext()) {
            Map.Entry<String, JsonNode> e = it.next();
            String v = text(e.getValue());
            if (v != null) {
                fields.put(e.getKey(), v);
            }
        }
        List<Link> links = new ArrayList<>();
        for (JsonNode r : w.path("relations")) {
            Link l = link(r);
            if (l != null) {
                links.add(l);
            }
        }
        String area = text(f.get("System.AreaPath"));
        URI url = URI.create(org.toString() + "/" + (project == null ? "" : encode(project) + "/") + "_workitems/edit/" + id);
        Map<String, Person> identities = new LinkedHashMap<>();
        putIdentity(identities, "assigned", f.get("System.AssignedTo"));
        putIdentity(identities, "created", f.get("System.CreatedBy"));
        putIdentity(identities, "changed", f.get("System.ChangedBy"));
        return new Item(id, type == null ? "Item" : type, type != null && !STANDARD_TYPES.contains(type), text(f.get("System.Title")),
                text(f.get("System.State")), text(f.get("System.AssignedTo")), leaf(area), text(f.get("System.IterationPath")), area, url,
                w.path("rev").asInt(0), instant(text(f.get("System.ChangedDate"))), text(f.get("System.ChangedBy")), fields, links, w.toString(),
                identities, project);
    }

    /** An identity field ({id, displayName, uniqueName}) as a person. */
    static Person person(JsonNode n) {
        if (n == null || !n.isObject()) {
            return null;
        }
        String id = n.path("id").asText(null);
        String name = n.path("displayName").asText(null);
        String unique = n.path("uniqueName").asText(null);
        return id == null && unique == null ? null : new Person(id == null ? unique : id, name == null ? unique : name, unique);
    }

    private static void putIdentity(Map<String, Person> out, String key, JsonNode n) {
        Person p = person(n);
        if (p != null) {
            out.put(key, p);
        }
    }

    /** One comment of {@code .../comments} (7.1-preview.4). */
    static Comment comment(JsonNode c) {
        return new Comment(c.path("id").asText(), text(c.get("createdBy")), instant(c.path("createdDate").asText(null)), c.path("text").asText(""));
    }

    static String encode(String s) {
        return java.net.URLEncoder.encode(s, java.nio.charset.StandardCharsets.UTF_8).replace("+", "%20");
    }

    /** A relation in neutral words; attachments are not links (they are read by AttachmentsReader). */
    static Link link(JsonNode r) {
        String rel = r.path("rel").asText("");
        String url = r.path("url").asText("");
        String kind = switch (rel) {
            case "System.LinkTypes.Hierarchy-Reverse" -> "Parent";
            case "System.LinkTypes.Hierarchy-Forward" -> "Child";
            case "System.LinkTypes.Related" -> "Related";
            case "System.LinkTypes.Dependency-Forward" -> "Successor";
            case "System.LinkTypes.Dependency-Reverse" -> "Predecessor";
            case "System.LinkTypes.Duplicate-Forward", "System.LinkTypes.Duplicate-Reverse" -> "Duplicate";
            case "ArtifactLink" -> artifact(r.path("attributes").path("name").asText(""));
            case "Hyperlink" -> "Hyperlink";
            case "AttachedFile" -> null;
            default -> rel.isEmpty() ? null : rel;
        };
        if (kind == null) {
            return null;
        }
        boolean workItem = url.contains("/_apis/wit/workItems/");
        return new Link(workItem ? url.substring(url.lastIndexOf('/') + 1) : url, kind);
    }

    private static String artifact(String name) {
        return switch (name) {
            case "Pull Request" -> "PullRequest";
            case "Fixed in Commit", "Commit" -> "Commit";
            case "Branch" -> "Branch";
            case "Build", "Found in build", "Integrated in build" -> "Build";
            default -> name.isEmpty() ? "Artifact" : name.replace(" ", "");
        };
    }

    /** One entry of {@code _apis/wit/workItems/{id}/updates}: who changed which fields from what to what. */
    static Revision revision(JsonNode u) {
        List<FieldChange> changes = new ArrayList<>();
        Iterator<Map.Entry<String, JsonNode>> it = u.path("fields").fields();
        while (it.hasNext()) {
            Map.Entry<String, JsonNode> e = it.next();
            if (e.getKey().equals("System.Rev") || e.getKey().equals("System.RevisedDate") || e.getKey().equals("System.AuthorizedDate")
                    || e.getKey().equals("System.Watermark")) {
                continue;
            }
            changes.add(new FieldChange(e.getKey(), text(e.getValue().get("oldValue")), text(e.getValue().get("newValue"))));
        }
        String at = text(u.path("fields").path("System.ChangedDate").get("newValue"));
        Instant when = instant(at != null ? at : u.path("revisedDate").asText(null));
        return new Revision(u.path("rev").asInt(0), text(u.get("revisedBy")), when, changes);
    }
}
