package com.fathy.alfred.backend.teamboards.core.application.service;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ItemCopyRow;
import com.fathy.alfred.backend.teamboards.spi.model.Comment;
import com.fathy.alfred.backend.teamboards.spi.model.Item;
import com.fathy.alfred.backend.teamboards.spi.model.Link;
import com.fathy.alfred.backend.teamboards.spi.model.Person;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.URI;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * A saved copy (specs/028 FR-032): the whole item - every field, relations, the raw item - and its comments, as JSON in
 * {@code item_copies}. Read back as the SPI's records so the seed, the diff and the attachments list work on it.
 */
public final class Copies {

    static final ObjectMapper JSON = JsonMapper.builder().addModule(new JavaTimeModule()).disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
            .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES).build();

    private Copies() {
    }

    /** The JSON shape of a copy: plain names, so a later Alfred reads an older copy. */
    record Doc(String extId, String type, boolean customType, String title, String state, String assignee, String squad, String sprint, String area,
               String url, int rev, Instant changedAt, String changedBy, Map<String, String> fields, List<Link> links, String nativeJson,
               Map<String, Person> identities, String project) {
    }

    public static String itemJson(Item i) {
        try {
            return JSON.writeValueAsString(new Doc(i.extId(), i.type(), i.customType(), i.title(), i.state(), i.assignee(), i.squad(), i.sprint(),
                    i.area(), i.url() == null ? null : i.url().toString(), i.rev(), i.changedAt(), i.changedBy(), i.fields(), i.links(), i.nativeJson(),
                    i.identities(), i.project()));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    public static String commentsJson(List<Comment> comments) {
        try {
            return JSON.writeValueAsString(comments == null ? List.of() : comments);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    public static Optional<Item> item(ItemCopyRow row) {
        return row == null ? Optional.empty() : item(row.itemJson());
    }

    public static Optional<Item> item(String json) {
        if (json == null || json.isBlank()) {
            return Optional.empty();
        }
        try {
            Doc d = JSON.readValue(json, Doc.class);
            URI url;
            try {
                url = d.url() == null || d.url().isBlank() ? null : URI.create(d.url());
            } catch (IllegalArgumentException e) {
                url = null;
            }
            return Optional.of(new Item(d.extId(), d.type() == null ? "Item" : d.type(), d.customType(), d.title(), d.state(), d.assignee(), d.squad(),
                    d.sprint(), d.area(), url, d.rev(), d.changedAt(), d.changedBy(), present(d.fields()), d.links(), d.nativeJson(), d.identities(),
                    d.project()));
        } catch (IOException e) {
            return Optional.empty();
        }
    }

    public static List<Comment> comments(ItemCopyRow row) {
        if (row == null || row.commentsJson() == null || row.commentsJson().isBlank()) {
            return List.of();
        }
        try {
            return JSON.readValue(row.commentsJson(), new TypeReference<List<Comment>>() { });
        } catch (IOException e) {
            return List.of();
        }
    }

    /** Item copies its fields with Map.copyOf, which refuses a null value: an empty field is left out. */
    static Map<String, String> present(Map<String, String> fields) {
        Map<String, String> out = new LinkedHashMap<>();
        if (fields != null) {
            fields.forEach((k, v) -> {
                if (k != null && v != null) {
                    out.put(k, v);
                }
            });
        }
        return out;
    }

    public static ItemCopyRow row(String conn, Item item, List<Comment> comments, Instant at) {
        return new ItemCopyRow(conn, item.extId(), item.rev(), itemJson(item), commentsJson(comments), at);
    }

    /** The item without its raw JSON - what a view or an MCP answer carries. */
    public static Item lean(Item i) {
        return new Item(i.extId(), i.type(), i.customType(), i.title(), i.state(), i.assignee(), i.squad(), i.sprint(), i.area(), i.url(), i.rev(),
                i.changedAt(), i.changedBy(), i.fields(), i.links(), null, i.identities(), i.project());
    }
}
