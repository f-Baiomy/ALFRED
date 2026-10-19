package com.fathy.alfred.backend.links.application.port.in;

import java.util.List;
import java.util.Map;

/**
 * A read sent over a link (R2): the owner's own path and query (refs already stripped of this link's suffix), the few
 * headers that matter (Accept), a small body for the peer API, and the hops it came through (R6) - the alfred ids of
 * every Alfred before the one answering, the reader first.
 */
public record RelayRequest(String method, String path, String query, Map<String, String> headers, String body, List<String> hops) {

    public RelayRequest {
        headers = headers == null ? Map.of() : Map.copyOf(headers);
        hops = hops == null ? List.of() : List.copyOf(hops);
        query = query == null ? "" : query;
    }

    public static RelayRequest get(String path, String query) {
        return new RelayRequest("GET", path, query, Map.of("Accept", "application/json"), null, List.of());
    }

    public RelayRequest withPath(String newPath, String newQuery) {
        return new RelayRequest(method, newPath, newQuery, headers, body, hops);
    }

    public RelayRequest withHops(List<String> newHops) {
        return new RelayRequest(method, path, query, headers, body, newHops);
    }
}
