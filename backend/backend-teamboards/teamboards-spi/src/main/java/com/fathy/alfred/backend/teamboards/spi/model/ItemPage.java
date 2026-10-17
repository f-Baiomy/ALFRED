package com.fathy.alfred.backend.teamboards.spi.model;

import java.util.List;

/** One page of a live search: the items, the total, and whether the provider's full-text search ran. */
public record ItemPage(List<Item> items, int total, boolean fullText) {
    public ItemPage {
        items = items == null ? List.of() : List.copyOf(items);
    }
}
