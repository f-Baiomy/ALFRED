package com.fathy.alfred.backend.teamboards.spi.model;

import java.util.List;
import java.util.Map;

/**
 * One edit of an existing item, sent as one request (specs/038 FR-4). {@code fields} by reference name ("" clears one);
 * {@code state} or null; {@code parent}: null keeps it, "" removes it, an id moves the item under it; links and tags to
 * add and remove.
 */
public record ItemUpdate(Map<String, String> fields, String state, String parent, List<Link> addLinks, List<Link> removeLinks,
                         List<String> addTags, List<String> removeTags) {
    public ItemUpdate {
        fields = fields == null ? Map.of() : Map.copyOf(fields);
        addLinks = addLinks == null ? List.of() : List.copyOf(addLinks);
        removeLinks = removeLinks == null ? List.of() : List.copyOf(removeLinks);
        addTags = addTags == null ? List.of() : List.copyOf(addTags);
        removeTags = removeTags == null ? List.of() : List.copyOf(removeTags);
    }

    public boolean empty() {
        return fields.isEmpty() && state == null && parent == null && addLinks.isEmpty() && removeLinks.isEmpty() && addTags.isEmpty()
                && removeTags.isEmpty();
    }
}
