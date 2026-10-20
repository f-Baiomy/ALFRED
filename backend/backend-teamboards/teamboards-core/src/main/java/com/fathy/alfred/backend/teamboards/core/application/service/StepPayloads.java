package com.fathy.alfred.backend.teamboards.core.application.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamException;
import com.fathy.alfred.backend.teamboards.spi.model.ItemUpdate;
import com.fathy.alfred.backend.teamboards.spi.model.Link;
import com.fathy.alfred.backend.teamboards.spi.model.NewItem;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The keys a CREATE or FIELD step carries since specs/038, all plain strings in the step's payload (no new step kind or
 * column, so an older Alfred reading a bundle meets nothing it cannot read): {@code fields} a JSON object of reference
 * name -> value, {@code links} / {@code addLinks} / {@code removeLinks} a JSON array of {@code {kind, id}}, {@code tags} /
 * {@code addTags} / {@code removeTags} names split by ";", {@code parent} an id ("" on an edit removes it), {@code item}
 * the item a step is for when it is not the bundle's own.
 */
final class StepPayloads {

    private static final ObjectMapper JSON = new ObjectMapper();
    /** The keys that make a FIELD step an edit of several things at once. */
    static final Set<String> EDIT_KEYS = Set.of("fields", "parent", "addLinks", "removeLinks", "addTags", "removeTags", "state");

    private StepPayloads() {
    }

    static Map<String, String> fields(Map<String, String> p) {
        return object(p.get("fields"), "fields");
    }

    static Map<String, String> object(String text, String what) {
        Map<String, String> out = new LinkedHashMap<>();
        if (text == null || text.isBlank()) {
            return out;
        }
        JsonNode n = read(text, what);
        if (!n.isObject()) {
            throw TeamException.invalid(what + " is a JSON object of field reference name -> value");
        }
        n.fields().forEachRemaining(e -> out.put(e.getKey().strip(), e.getValue().isNull() ? "" : e.getValue().isTextual()
                ? e.getValue().asText() : e.getValue().toString()));
        return out;
    }

    static List<Link> links(Map<String, String> p, String key) {
        String text = p.get(key);
        List<Link> out = new ArrayList<>();
        if (text == null || text.isBlank()) {
            return out;
        }
        JsonNode n = read(text, key);
        if (!n.isArray()) {
            throw TeamException.invalid(key + " is a JSON array of {kind, id}");
        }
        for (JsonNode l : n) {
            String id = l.path("id").asText("").strip();
            String kind = l.path("kind").asText("").strip();
            if (id.isEmpty() || kind.isEmpty()) {
                throw TeamException.invalid("Every link in " + key + " names its kind and the other item's id");
            }
            out.add(new Link(id, kind));
        }
        return out;
    }

    static List<String> tags(Map<String, String> p, String key) {
        String text = p.get(key);
        List<String> out = new ArrayList<>();
        if (text == null) {
            return out;
        }
        for (String t : text.split(";")) {
            if (!t.isBlank()) {
                out.add(t.strip());
            }
        }
        return out;
    }

    static String write(Object value) {
        try {
            return JSON.writeValueAsString(value);
        } catch (JsonProcessingException e) {
            throw TeamException.invalid("Could not write " + value.getClass().getSimpleName());
        }
    }

    private static JsonNode read(String text, String what) {
        try {
            return JSON.readTree(text);
        } catch (JsonProcessingException e) {
            throw TeamException.invalid(what + " is not valid JSON");
        }
    }

    /** The item a CREATE step makes. */
    static NewItem newItem(Map<String, String> p) {
        return new NewItem(p.get("project"), p.get("type").strip(), p.get("title").strip(), p.get("description"), p.get("area"),
                p.get("iteration"), p.get("assignee"), blank(p.get("parent")), fields(p), links(p, "links"), tags(p, "tags"));
    }

    /** Whether a FIELD step is an edit of several things (else the one field of specs/030). */
    static boolean isEdit(Map<String, String> p) {
        return EDIT_KEYS.stream().anyMatch(p::containsKey);
    }

    /** The edit a FIELD step makes; the single {@code field}/{@code value} of specs/030 is one field of it. */
    static ItemUpdate update(Map<String, String> p) {
        Map<String, String> fields = fields(p);
        if (p.get("field") != null && !p.get("field").isBlank()) {
            fields.put(p.get("field").strip(), p.getOrDefault("value", ""));
        }
        String state = blank(p.get("state"));
        return new ItemUpdate(fields, state, p.containsKey("parent") ? p.get("parent").strip() : null, links(p, "addLinks"),
                links(p, "removeLinks"), tags(p, "addTags"), tags(p, "removeTags"));
    }

    static String blank(String s) {
        return s == null || s.isBlank() ? null : s.strip();
    }
}
