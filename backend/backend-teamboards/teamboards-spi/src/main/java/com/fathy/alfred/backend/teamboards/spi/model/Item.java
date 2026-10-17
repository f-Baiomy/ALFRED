package com.fathy.alfred.backend.teamboards.spi.model;

import java.net.URI;
import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * A work item in neutral terms. {@code fields} holds every field the provider sent, by its reference name (HTML fields
 * as HTML); {@code nativeJson} the raw item, kept in a saved copy but never listed. {@code changedBy}: who made revision
 * {@code rev}. {@code identities}: the person behind "assigned", "created" and "changed" (neutral keys), so a pill shows
 * who it is without a lookup. {@code project}: the provider project the item lives in.
 */
public record Item(String extId, String type, boolean customType, String title, String state, String assignee, String squad,
                   String sprint, String area, URI url, int rev, Instant changedAt, String changedBy, Map<String, String> fields,
                   List<Link> links, String nativeJson, Map<String, Person> identities, String project) {
    public Item {
        fields = fields == null ? Map.of() : Map.copyOf(fields);
        links = links == null ? List.of() : List.copyOf(links);
        identities = identities == null ? Map.of() : Map.copyOf(identities);
    }

    public Item(String extId, String type, boolean customType, String title, String state, String assignee, String squad, String sprint,
                String area, URI url, int rev, Instant changedAt, String changedBy, Map<String, String> fields, List<Link> links, String nativeJson) {
        this(extId, type, customType, title, state, assignee, squad, sprint, area, url, rev, changedAt, changedBy, fields, links, nativeJson,
                Map.of(), null);
    }

    /** The person assigned, when the provider named one. */
    public Person assignedPerson() {
        return identities.get("assigned");
    }
}
