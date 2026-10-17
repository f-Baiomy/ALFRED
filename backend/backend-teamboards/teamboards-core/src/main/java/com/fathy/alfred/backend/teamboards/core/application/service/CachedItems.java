package com.fathy.alfred.backend.teamboards.core.application.service;

import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort.StoredConnection;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ItemSummary;
import com.fathy.alfred.backend.teamboards.spi.Connector;
import com.fathy.alfred.backend.teamboards.spi.model.Connection;
import com.fathy.alfred.backend.teamboards.spi.model.Item;

import java.net.URI;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/** The cache read back as the SPI's records, for the connector hooks that work on a cached item (seed, attachments listed). */
final class CachedItems {

    private CachedItems() {
    }

    static Map<String, Connector> byKind(List<Connector> connectors) {
        Map<String, Connector> out = new LinkedHashMap<>();
        for (Connector c : connectors == null ? List.<Connector>of() : connectors) {
            out.put(c.kind(), c);
        }
        return out;
    }

    static Connection connection(StoredConnection c) {
        return new Connection(c.id(), c.kind(), c.name(), URI.create(c.baseUrl()), c.scope());
    }

    /** Item copies its fields with Map.copyOf, which refuses a null value: an empty field is left out. */
    static Map<String, String> present(Map<String, String> fields) {
        Map<String, String> out = new LinkedHashMap<>();
        fields.forEach((k, v) -> {
            if (k != null && v != null) {
                out.put(k, v);
            }
        });
        return out;
    }

    static Optional<Item> item(TeamCachePort cache, String conn, String extId) {
        Optional<ItemSummary> found = cache.summary(conn, extId);
        if (found.isEmpty()) {
            return Optional.empty();
        }
        ItemSummary s = found.get();
        URI url;
        try {
            url = s.url() == null || s.url().isBlank() ? null : URI.create(s.url());
        } catch (IllegalArgumentException e) {
            url = null;
        }
        return Optional.of(new Item(s.extId(), s.type(), s.customType(), s.title(), s.state(), s.assignee(), s.squad(), s.sprint(), s.area(), url,
                s.rev(), s.changedAt(), null, present(cache.fields(conn, extId)), cache.links(conn, extId), cache.nativeJson(conn, extId).orElse(null)));
    }
}
