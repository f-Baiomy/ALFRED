package com.fathy.alfred.backend.teamboards.spi.model;

import java.util.List;
import java.util.Map;

/**
 * An item to create in the tracker (specs/028 FR-052, specs/038 FR-1). Description is HTML or Markdown.
 * {@code parent}: the id of the item it goes under, or null. {@code fields}: any further fields by reference name
 * (Activity, estimates, priority, custom ones), {@code links} extra relations, {@code tags} its tags - all sent in the one
 * create request.
 */
public record NewItem(String project, String type, String title, String description, String area, String iteration, String assignee,
                      String parent, Map<String, String> fields, List<Link> links, List<String> tags) {
    public NewItem {
        fields = fields == null ? Map.of() : Map.copyOf(fields);
        links = links == null ? List.of() : List.copyOf(links);
        tags = tags == null ? List.of() : List.copyOf(tags);
    }

    public NewItem(String project, String type, String title, String description, String area, String iteration, String assignee,
                   String parent) {
        this(project, type, title, description, area, iteration, assignee, parent, Map.of(), List.of(), List.of());
    }

    public NewItem(String project, String type, String title, String description, String area, String iteration, String assignee) {
        this(project, type, title, description, area, iteration, assignee, null);
    }
}
