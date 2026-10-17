package com.fathy.alfred.backend.teamboards.spi.model;

import java.net.URI;
import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * A work item in neutral terms. {@code fields} holds every field the provider sent, by its reference name (HTML fields
 * as HTML); {@code nativeJson} the raw item, stored but never listed. {@code changedBy}: who made revision {@code rev}.
 */
public record Item(String extId, String type, boolean customType, String title, String state, String assignee, String squad,
                   String sprint, String area, URI url, int rev, Instant changedAt, String changedBy, Map<String, String> fields,
                   List<Link> links, String nativeJson) {

    public Item {
        fields = fields == null ? Map.of() : Map.copyOf(fields);
        links = links == null ? List.of() : List.copyOf(links);
    }
}
